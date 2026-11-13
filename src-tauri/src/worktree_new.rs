//! New worktree for a task (docs/design/git.md section 3.27): plans and creates a worktree as a
//! sibling of the main worktree, branched off the comparison ref, copies the gitignored files
//! `.worktreeinclude` lists, assigns `BB_WORKTREE_INDEX`, and reports whether the worktree's
//! `.bashboard/setup.sh` is already trusted. The Tauri commands and `POST /worktree`
//! (`worktree_route.rs`) both run through [`plan`] and [`create`].

use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    files::{display, find_repo},
    git::{Git, run},
    git_worktrees::{comparison_for, configured_for, main_worktree_path},
    lock::LockExt,
    settings::SettingsState,
    worktree_trust,
};

pub(crate) const INCLUDE_FILE: &str = ".worktreeinclude";
pub(crate) const INDEX_FILE: &str = "bashboard-index";
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePlan {
    pub main_root: String,
    pub branch: String,
    pub base_ref: String,
    pub base_sha: String,
    pub short_sha: String,
    pub path: String,
    pub name: String,
    /// Whether the base is the comparison ref, so the caller shows the `--from HEAD` hint.
    pub hint: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupState {
    None,
    Trusted,
    NeedsApproval,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreated {
    pub plan: WorktreePlan,
    pub index: u32,
    pub copied: Vec<String>,
    pub warnings: Vec<String>,
    pub setup: SetupState,
}

/// `branch` as a folder-name suffix: path separators and characters Windows forbids in file
/// names become `-`, and leading and trailing dots and spaces go, since Windows drops trailing
/// ones silently.
pub(crate) fn sanitize(branch: &str) -> String {
    branch
        .chars()
        .map(|c| match c {
            '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect::<String>()
        .trim_matches(|c| c == '.' || c == ' ')
        .to_string()
}

fn has_ref(g: &Git, name: &str) -> Result<bool, String> {
    Ok(g.read(["show-ref", "--verify", "-q", name])?.ok)
}

fn check_branch(g: &Git, branch: &str) -> Result<(), String> {
    let invalid = || format!("not a valid branch name: {branch}");
    if branch.is_empty() || branch.starts_with('-') {
        return Err(invalid());
    }
    // `--branch` also expands `@{-1}` and the like; anything it rewrites is not a plain name.
    let out = g.read(["check-ref-format", "--branch", branch])?;
    if !out.ok || out.stdout() != branch {
        return Err(invalid());
    }
    if has_ref(g, &format!("refs/heads/{branch}"))? {
        return Err(format!("branch {branch} already exists; pick another name"));
    }
    Ok(())
}

/// The commit `rev` names, or `None` when it names none.
fn commit_of(g: &Git, rev: &str) -> Result<Option<String>, String> {
    let spec = format!("{rev}^{{commit}}");
    let out = g.read(["rev-parse", "--verify", "-q", "--end-of-options", &spec])?;
    Ok(out.ok.then(|| out.stdout()))
}

/// What [`create`] would do, checked without changing anything and without fetching. `g` runs in
/// the calling folder's worktree, so `from` of `HEAD` is that folder's current commit.
pub(crate) fn plan(
    g: &Git,
    branch: &str,
    from: Option<&str>,
    configured: Option<&str>,
) -> Result<WorktreePlan, String> {
    let branch = branch.trim();
    check_branch(g, branch)?;
    let from = from.map(str::trim).filter(|f| !f.is_empty());
    let (base_ref, rev) = match from {
        Some(f) => (f.to_string(), f.to_string()),
        None => match comparison_for(g, configured)? {
            (Some(short), Some(full)) => (short, full),
            _ => {
                return Err("no comparison branch to branch from; pass --from <ref>".to_string());
            }
        },
    };
    let base_sha = commit_of(g, &rev)?.ok_or_else(|| format!("no commit named {base_ref}"))?;
    let short_sha = Git::ok(g.read(["rev-parse", "--short", &base_sha])?)?;
    let main_root = main_worktree_path(g)?;
    let main = Path::new(&main_root);
    let (Some(parent), Some(folder)) = (main.parent(), main.file_name()) else {
        return Err(format!(
            "the main worktree has no parent folder: {main_root}"
        ));
    };
    let suffix = sanitize(branch);
    if suffix.is_empty() {
        return Err(format!("not a valid branch name: {branch}"));
    }
    let name = format!("{}-{suffix}", folder.to_string_lossy());
    let path = parent.join(&name);
    if fs::symlink_metadata(&path).is_ok() {
        return Err(format!("{} already exists", display(&path)));
    }
    Ok(WorktreePlan {
        main_root,
        branch: branch.to_string(),
        base_ref,
        base_sha,
        short_sha,
        path: display(&path),
        name,
        hint: from.is_none(),
    })
}

/// The remote to fetch: the comparison ref's, else the current branch's upstream remote, else
/// `origin`; `None` when the repo has no such remote.
fn fetch_remote(g: &Git, configured: Option<&str>) -> Result<Option<String>, String> {
    let remotes: Vec<String> = Git::ok(g.read(["remote"])?)?
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(str::to_string)
        .collect();
    let (_, full) = comparison_for(g, configured)?;
    let from_comparison = full.as_deref().and_then(|f| {
        let rest = f.strip_prefix("refs/remotes/")?;
        remotes
            .iter()
            .find(|r| rest.starts_with(&format!("{r}/")))
            .cloned()
    });
    let from_upstream = || {
        let out = g
            .read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .ok()?;
        let upstream = out.ok.then(|| out.stdout())?;
        remotes
            .iter()
            .find(|r| upstream.starts_with(&format!("{r}/")))
            .cloned()
    };
    Ok(from_comparison
        .or_else(from_upstream)
        .or_else(|| remotes.iter().find(|r| *r == "origin").cloned()))
}

/// Fetches before branching so the base is current; any failure is a warning, since branching
/// from local refs still works offline.
fn fetch(g: &Git, configured: Option<&str>) -> Option<String> {
    let remote = match fetch_remote(g, configured) {
        Ok(Some(r)) => r,
        Ok(None) => return Some("no remote to fetch; branching from local refs".to_string()),
        Err(e) => return Some(format!("fetch skipped ({e}); branching from local refs")),
    };
    // Timed, so an unreachable host cannot hold `bb worktree new` or the dialog forever.
    let out = g.read_input(
        ["fetch", "--end-of-options", &remote],
        b"",
        &[],
        &[],
        FETCH_TIMEOUT,
    );
    match out.and_then(Git::ok) {
        Ok(_) => None,
        Err(e) => Some(format!(
            "fetch from {remote} failed; branching from local refs: {}",
            e.lines().last().unwrap_or("").trim()
        )),
    }
}

/// One `.worktreeinclude` line as a safe relative path, or why it is skipped.
fn include_path(line: &str) -> Result<String, String> {
    if line.starts_with('!') || line.contains(['*', '?', '[']) {
        return Err(format!(
            "{INCLUDE_FILE}: skipped {line}: only literal paths are supported"
        ));
    }
    let rel = line.replace('\\', "/").trim_end_matches('/').to_string();
    let p = Path::new(&rel);
    let escapes = p.is_absolute()
        || p.components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir));
    if rel.is_empty() || escapes {
        return Err(format!(
            "{INCLUDE_FILE}: skipped {line}: not a path inside the repo"
        ));
    }
    Ok(rel)
}

/// Copies a file or folder tree, skipping symbolic links, which could point anywhere.
fn copy_tree(from: &Path, to: &Path, warnings: &mut Vec<String>) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        warnings.push(format!("{INCLUDE_FILE}: skipped link {}", display(from)));
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()), warnings)?;
        }
        return Ok(());
    }
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::copy(from, to).map(|_| ())
}

/// Copies each literal path `.worktreeinclude` lists from the main worktree into `dest`, when it
/// exists, is untracked, and is gitignored. Returns the copied paths; skips become warnings.
pub(crate) fn copy_includes(main: &Git, dest: &Path, warnings: &mut Vec<String>) -> Vec<String> {
    let Ok(text) = fs::read_to_string(main.root().join(INCLUDE_FILE)) else {
        return Vec::new();
    };
    let mut copied = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let rel = match include_path(line) {
            Ok(r) => r,
            Err(w) => {
                warnings.push(w);
                continue;
            }
        };
        let source = main.root().join(&rel);
        if fs::symlink_metadata(&source).is_err() {
            warnings.push(format!("{INCLUDE_FILE}: skipped {rel}: not found"));
            continue;
        }
        let tracked = main
            .read(["ls-files", "-z", "--", &rel])
            .map(|o| !o.ok || !o.stdout.is_empty());
        if tracked.unwrap_or(true) {
            warnings.push(format!("{INCLUDE_FILE}: skipped {rel}: tracked by git"));
            continue;
        }
        // check-ignore refuses to run under the runner's GIT_LITERAL_PATHSPECS, and the path is
        // already known to hold no glob characters.
        let ignored = main
            .read_input(
                ["check-ignore", "-q", "--", &rel],
                b"",
                &[],
                &["GIT_LITERAL_PATHSPECS"],
                GIT_TIMEOUT,
            )
            .map(|o| o.ok);
        if !ignored.unwrap_or(false) {
            warnings.push(format!("{INCLUDE_FILE}: skipped {rel}: not gitignored"));
            continue;
        }
        match copy_tree(&source, &dest.join(&rel), warnings) {
            Ok(()) => copied.push(rel),
            Err(e) => warnings.push(format!("{INCLUDE_FILE}: could not copy {rel}: {e}")),
        }
    }
    copied
}

fn read_index(admin: &Path) -> Option<u32> {
    fs::read_to_string(admin.join(INDEX_FILE))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// The smallest positive integer not in `used`.
pub(crate) fn smallest_unused(used: &HashSet<u32>) -> u32 {
    (1..).find(|n| !used.contains(n)).unwrap_or(1)
}

/// Serializes index assignment, so two worktrees created at once cannot take the same number.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// The worktree's `BB_WORKTREE_INDEX`: the number recorded in its git admin dir, or else the
/// smallest one no other worktree of the repo records, written there.
pub(crate) fn assign_index(worktree: &Git) -> Result<u32, String> {
    let _guard = INDEX_LOCK.lock_or_recover();
    let git_dir = Git::ok(worktree.read(["rev-parse", "--git-dir"])?)?;
    let admin = worktree.root().join(git_dir);
    if let Some(n) = read_index(&admin) {
        return Ok(n);
    }
    let common = worktree.common_dir()?;
    let own = fs::canonicalize(&admin).ok();
    let mut used = HashSet::new();
    used.extend(read_index(&common));
    if let Ok(entries) = fs::read_dir(common.join("worktrees")) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if fs::canonicalize(&dir).ok() == own {
                continue;
            }
            used.extend(read_index(&dir));
        }
    }
    let n = smallest_unused(&used);
    crate::atomic_file::write_atomic(&admin.join(INDEX_FILE), format!("{n}\n"))?;
    Ok(n)
}

/// The worktree's setup script path.
pub(crate) fn setup_script_path(worktree: &Path) -> PathBuf {
    worktree.join(".bashboard").join("setup.sh")
}

/// The worktree's setup script text, or `None` when it has none.
pub(crate) fn read_setup_script(worktree: &Path) -> Result<Option<String>, String> {
    let path = setup_script_path(worktree);
    match fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| format!("{} is not UTF-8 text", display(&path))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", display(&path))),
    }
}

pub(crate) fn setup_state(
    main_root: &str,
    worktree: &Path,
    trust_file: Option<&Path>,
) -> SetupState {
    match read_setup_script(worktree) {
        Ok(None) => SetupState::None,
        Ok(Some(text)) => match trust_file {
            Some(f) if worktree_trust::is_trusted(f, main_root, &text) => SetupState::Trusted,
            _ => SetupState::NeedsApproval,
        },
        // Unreadable: ask, and the approval step reports why it cannot be read.
        Err(_) => SetupState::NeedsApproval,
    }
}

/// Fetches, branches off the re-resolved base into a new sibling worktree, copies the includes,
/// and assigns the index. `trust_file` is the approved-scripts store, `None` outside the app.
pub(crate) fn create(
    g: &Git,
    branch: &str,
    from: Option<&str>,
    configured: Option<&str>,
    trust_file: Option<&Path>,
) -> Result<WorktreeCreated, String> {
    // Checked before fetching, so a bad name fails without a network round trip.
    plan(g, branch, from, configured)?;
    let mut warnings: Vec<String> = fetch(g, configured).into_iter().collect();
    let plan = plan(g, branch, from, configured)?;
    // Branching from the commit, not the ref, keeps git from making a remote branch such as
    // origin/main the new branch's upstream, where a bare `git push` would land on it.
    let out = g.write([
        "worktree",
        "add",
        "-b",
        &plan.branch,
        "--end-of-options",
        &plan.path,
        &plan.base_sha,
    ])?;
    Git::ok(out)?;
    let path = PathBuf::from(&plan.path);
    let main = g.at(PathBuf::from(&plan.main_root));
    let copied = copy_includes(&main, &path, &mut warnings);
    let index = assign_index(&g.at(path.clone()))?;
    let setup = setup_state(&plan.main_root, &path, trust_file);
    Ok(WorktreeCreated {
        plan,
        index,
        copied,
        warnings,
        setup,
    })
}

/// The repo root `cwd` is in, for opening git there.
pub(crate) fn repo_root(cwd: &str) -> Result<String, String> {
    match find_repo(cwd)? {
        r if r.is_git => Ok(r.root),
        _ => Err("not a git repository".to_string()),
    }
}

#[tauri::command]
pub async fn worktree_plan(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    cwd: String,
    branch: String,
    from: Option<String>,
) -> Result<WorktreePlan, String> {
    let root = repo_root(&cwd)?;
    run(settings, root, move |g| {
        let configured = configured_for(&app, g)?;
        plan(g, &branch, from.as_deref(), configured.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn worktree_create(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    cwd: String,
    branch: String,
    from: Option<String>,
) -> Result<WorktreeCreated, String> {
    let root = repo_root(&cwd)?;
    run(settings, root, move |g| {
        let configured = configured_for(&app, g)?;
        let trust = worktree_trust::store_path(&app);
        create(
            g,
            &branch,
            from.as_deref(),
            configured.as_deref(),
            trust.as_deref(),
        )
    })
    .await
}

/// The setup script of the worktree at `path`, for showing before approval.
#[tauri::command]
pub async fn worktree_setup_script(path: String) -> Result<Option<String>, String> {
    let dir = crate::files::normalize(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_setup_script(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::git::test_support::{Repo, commit_file, repo, sh, temp_dir, with_bare_remote};

    /// Removes the sibling worktrees a test created next to its repo.
    pub(crate) struct Siblings(pub(crate) Vec<PathBuf>);

    impl Drop for Siblings {
        fn drop(&mut self) {
            for p in &self.0 {
                let _ = fs::remove_dir_all(p);
            }
        }
    }

    fn sibling(r: &Repo, branch: &str) -> PathBuf {
        let root = r.root();
        root.parent().unwrap().join(format!(
            "{}-{}",
            root.file_name().unwrap().to_string_lossy(),
            sanitize(branch)
        ))
    }

    /// A repo with one commit on main, pushed to a bare remote, so `origin/main` exists.
    fn pushed_repo(tag: &str) -> Repo {
        let r = repo(tag);
        commit_file(&r, "a.txt", "a", "first");
        with_bare_remote(&r);
        sh(r.root(), &["push", "-q", "-u", "origin", "main"]);
        r
    }

    #[test]
    fn worktree_sanitize_replaces_separators_and_trims() {
        assert_eq!(sanitize("feature/login"), "feature-login");
        assert_eq!(sanitize("a\\b:c*d?e\"f<g>h|i"), "a-b-c-d-e-f-g-h-i");
        assert_eq!(sanitize(" .x. "), "x");
        assert_eq!(sanitize("..."), "");
    }

    #[test]
    fn worktree_smallest_unused_fills_gaps() {
        assert_eq!(smallest_unused(&HashSet::new()), 1);
        assert_eq!(smallest_unused(&[1, 2, 4].into_iter().collect()), 3);
        assert_eq!(smallest_unused(&[2, 3].into_iter().collect()), 1);
    }

    #[test]
    fn worktree_include_path_rules() {
        assert_eq!(include_path(".env").unwrap(), ".env");
        assert_eq!(include_path("config\\local/").unwrap(), "config/local");
        assert!(include_path("*.env").unwrap_err().contains("literal"));
        assert!(include_path("a?").is_err());
        assert!(include_path("[ab]").is_err());
        assert!(include_path("!keep").unwrap_err().contains("literal"));
        assert!(
            include_path("../x")
                .unwrap_err()
                .contains("inside the repo")
        );
        assert!(include_path("/etc/passwd").is_err());
    }

    #[test]
    fn worktree_plan_errors() {
        let r = pushed_repo("wt-plan-err");
        assert!(
            plan(&r, "bad..name", None, None)
                .unwrap_err()
                .contains("not a valid")
        );
        assert!(
            plan(&r, "-x", None, None)
                .unwrap_err()
                .contains("not a valid")
        );
        assert!(
            plan(&r, "@{-1}", None, None)
                .unwrap_err()
                .contains("not a valid")
        );
        assert!(
            plan(&r, "main", None, None)
                .unwrap_err()
                .contains("already exists")
        );
        let taken = sibling(&r, "taken");
        let _cleanup = Siblings(vec![taken.clone()]);
        fs::create_dir_all(&taken).unwrap();
        assert!(
            plan(&r, "taken", None, None)
                .unwrap_err()
                .contains("already exists")
        );
        assert!(
            plan(&r, "x", Some("nope"), None)
                .unwrap_err()
                .contains("no commit named nope")
        );
    }

    #[test]
    fn worktree_plan_from_comparison_and_head() {
        let r = pushed_repo("wt-plan");
        let base = sh(r.root(), &["rev-parse", "HEAD"]);
        let local = commit_file(&r, "b.txt", "b", "local only");
        let p = plan(&r, "feature/x", None, None).unwrap();
        assert_eq!(p.base_ref, "origin/main");
        assert_eq!(p.base_sha, base);
        assert!(base.starts_with(&p.short_sha));
        assert!(p.hint);
        assert_eq!(PathBuf::from(&p.path), sibling(&r, "feature/x"));
        assert_eq!(
            p.name,
            sibling(&r, "feature/x")
                .file_name()
                .unwrap()
                .to_string_lossy()
        );
        assert_eq!(p.main_root, display(r.root()));
        let h = plan(&r, "feature/x", Some("HEAD"), None).unwrap();
        assert_eq!(h.base_ref, "HEAD");
        assert_eq!(h.base_sha, local);
        assert!(!h.hint);
    }

    #[test]
    fn worktree_create_end_to_end() {
        let r = pushed_repo("wt-create");
        // A commit that reaches the remote only through another clone, so the fetch matters.
        let other = crate::git::test_support::clone_of(&r);
        let remote_tip = crate::git::test_support::commit_in(&other, "c.txt", "c", "remote");
        sh(&other, &["push", "-q", "origin", "main"]);
        commit_file(
            &r,
            ".gitignore",
            ".env\nnode_modules/\nlocal.txt\n",
            "ignore",
        );
        // `.gitignore` is now ahead of origin/main, so the worktree checks out the remote tip,
        // which lacks it; includes are judged in the main worktree, where it exists.
        fs::write(r.root().join(".env"), "SECRET=1").unwrap();
        fs::create_dir_all(r.root().join("node_modules/pkg")).unwrap();
        fs::write(r.root().join("node_modules/pkg/index.js"), "x").unwrap();
        fs::write(r.root().join("untracked.txt"), "u").unwrap();
        fs::write(
            r.root().join(INCLUDE_FILE),
            "# comment\n\n.env\nnode_modules\n*.log\n!x\na.txt\nmissing.txt\nuntracked.txt\n",
        )
        .unwrap();
        let path = sibling(&r, "feat/one");
        let _cleanup = Siblings(vec![path.clone()]);
        let c = create(&r, "feat/one", None, None, None).unwrap();
        assert_eq!(c.plan.base_sha, remote_tip, "{:?}", c.warnings);
        assert_eq!(PathBuf::from(&c.plan.path), path);
        assert_eq!(c.copied, vec![".env", "node_modules"], "{:?}", c.warnings);
        assert_eq!(fs::read_to_string(path.join(".env")).unwrap(), "SECRET=1");
        assert!(path.join("node_modules/pkg/index.js").is_file());
        let w = c.warnings.join("\n");
        assert!(w.contains("*.log: only literal"), "{w}");
        assert!(w.contains("!x: only literal"), "{w}");
        assert!(w.contains("a.txt: tracked"), "{w}");
        assert!(w.contains("missing.txt: not found"), "{w}");
        assert!(w.contains("untracked.txt: not gitignored"), "{w}");
        assert!(!w.contains("fetch"), "{w}");
        assert_eq!(c.index, 1);
        assert_eq!(c.setup, SetupState::None);
        assert_eq!(
            sh(&path, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "feat/one"
        );
        // No upstream was set from the base.
        assert!(
            !r.read(["rev-parse", "--verify", "-q", "feat/one@{u}"])
                .unwrap()
                .ok,
            "the new branch must not track origin/main"
        );
        assert!(
            create(&r, "feat/one", None, None, None)
                .unwrap_err()
                .contains("already exists")
        );
    }

    #[test]
    fn worktree_create_without_remote_warns_and_continues() {
        let r = repo("wt-noremote");
        let head = commit_file(&r, "a.txt", "a", "first");
        let path = sibling(&r, "solo");
        let _cleanup = Siblings(vec![path.clone()]);
        let c = create(&r, "solo", Some("HEAD"), None, None).unwrap();
        assert_eq!(c.plan.base_sha, head);
        assert!(
            c.warnings.iter().any(|w| w.contains("no remote")),
            "{:?}",
            c.warnings
        );
        assert!(path.join("a.txt").is_file());
    }

    #[test]
    fn worktree_create_with_unreachable_remote_warns_and_continues() {
        let r = pushed_repo("wt-gone");
        let bare = r.remotes.borrow()[0].clone();
        fs::remove_dir_all(&bare).unwrap();
        let path = sibling(&r, "offline");
        let _cleanup = Siblings(vec![path.clone()]);
        let c = create(&r, "offline", None, None, None).unwrap();
        assert!(
            c.warnings
                .iter()
                .any(|w| w.contains("fetch from origin failed")),
            "{:?}",
            c.warnings
        );
        assert!(path.join("a.txt").is_file());
    }

    #[test]
    fn worktree_index_assignment_reuses_gaps() {
        let r = repo("wt-index");
        commit_file(&r, "a.txt", "a", "first");
        let names = ["one", "two", "three"];
        let paths: Vec<PathBuf> = names.iter().map(|n| sibling(&r, n)).collect();
        let _cleanup = Siblings(paths.clone());
        let made: Vec<u32> = names
            .iter()
            .map(|n| create(&r, n, Some("HEAD"), None, None).unwrap().index)
            .collect();
        assert_eq!(made, vec![1, 2, 3]);
        // Read back, not reassigned.
        assert_eq!(assign_index(&r.at(paths[1].clone())).unwrap(), 2);
        sh(
            r.root(),
            &["worktree", "remove", &paths[1].to_string_lossy()],
        );
        assert_eq!(
            create(&r, "four", Some("HEAD"), None, None).unwrap().index,
            2
        );
        let _more = Siblings(vec![sibling(&r, "four")]);
    }

    #[test]
    fn worktree_setup_state_follows_trust() {
        let r = repo("wt-setup");
        fs::create_dir_all(r.root().join(".bashboard")).unwrap();
        commit_file(&r, ".bashboard/setup.sh", "echo hi\n", "setup");
        let store = temp_dir("wt-trust").join("worktree-trust.json");
        let path = sibling(&r, "s");
        let _cleanup = Siblings(vec![path.clone()]);
        let c = create(&r, "s", Some("HEAD"), None, Some(&store)).unwrap();
        assert_eq!(c.setup, SetupState::NeedsApproval);
        assert_eq!(
            read_setup_script(&path).unwrap().as_deref(),
            Some("echo hi\n")
        );
        worktree_trust::trust(&store, &c.plan.main_root, "echo hi\n").unwrap();
        assert_eq!(
            setup_state(&c.plan.main_root, &path, Some(&store)),
            SetupState::Trusted
        );
        fs::write(setup_script_path(&path), "echo changed\n").unwrap();
        assert_eq!(
            setup_state(&c.plan.main_root, &path, Some(&store)),
            SetupState::NeedsApproval
        );
        assert_eq!(read_setup_script(r.root().parent().unwrap()).unwrap(), None);
        let _ = fs::remove_dir_all(store.parent().unwrap());
    }

    #[test]
    fn worktree_json_shapes() {
        let c = WorktreeCreated {
            plan: WorktreePlan {
                main_root: "C:\\r".into(),
                branch: "b".into(),
                base_ref: "origin/main".into(),
                base_sha: "abc123".into(),
                short_sha: "abc".into(),
                path: "C:\\r-b".into(),
                name: "r-b".into(),
                hint: true,
            },
            index: 2,
            copied: vec![".env".into()],
            warnings: vec![],
            setup: SetupState::NeedsApproval,
        };
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            serde_json::json!({
                "plan": {
                    "mainRoot": "C:\\r", "branch": "b", "baseRef": "origin/main",
                    "baseSha": "abc123", "shortSha": "abc", "path": "C:\\r-b", "name": "r-b",
                    "hint": true,
                },
                "index": 2, "copied": [".env"], "warnings": [], "setup": "needsApproval",
            })
        );
        assert_eq!(serde_json::to_value(SetupState::None).unwrap(), "none");
    }
}
