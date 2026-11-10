//! The Repo section's worktree commands (design section 3.9), run through `git.rs`'s runner.
//!
//! Reads carry `GIT_OPTIONAL_LOCKS=0`; removal never passes `--force` and never runs
//! `branch -D`.

use std::{collections::HashMap, path::Path};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    files::display,
    git::{Git, parse_status, run},
    settings::SettingsState,
    workspace::{configured_primary_branch, same_root},
};

const FALLBACK_PRIMARIES: [&str; 4] = ["dev", "develop", "main", "master"];

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryBranch {
    branch: Option<String>,
    comparison: Option<String>,
    configured: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergedState {
    Merged,
    ProbablyMerged,
    NotMerged,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    main: bool,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
    upstream: Option<String>,
    upstream_gone: bool,
    ahead: u32,
    behind: u32,
    merged: MergedState,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeList {
    primary: PrimaryBranch,
    local_branches: Vec<String>,
    worktrees: Vec<Worktree>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadCommit {
    hash: String,
    subject: String,
    time: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDetail {
    path: String,
    branch: Option<String>,
    head: Option<HeadCommit>,
    comparison: Option<String>,
    ahead: u32,
    behind: u32,
    merged: MergedState,
    upstream: Option<String>,
    upstream_gone: bool,
    upstream_ahead: u32,
    upstream_behind: u32,
    staged: u32,
    changed: u32,
    untracked: u32,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    branch_error: Option<String>,
}

/// One entry of `worktree list --porcelain`, as git printed it.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct RawWorktree {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    main: bool,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
}

/// Parses `worktree list --porcelain -z`: NUL-terminated lines, an empty one between entries.
/// A bare repo's entry is skipped, and then no entry is the main worktree.
pub(crate) fn parse_worktrees(bytes: &[u8]) -> Vec<RawWorktree> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::new();
    let mut current: Option<(RawWorktree, bool)> = None;
    let mut first = true;
    let mut finish = |entry: Option<(RawWorktree, bool)>| {
        if let Some((w, bare)) = entry {
            if !bare {
                out.push(w);
            }
        }
    };
    for rec in text.split('\0') {
        let (key, value) = match rec.split_once(' ') {
            Some((k, v)) => (k, Some(v)),
            None => (rec, None),
        };
        if key == "worktree" {
            finish(current.take());
            let w = RawWorktree {
                path: value.unwrap_or_default().to_string(),
                main: first,
                ..RawWorktree::default()
            };
            first = false;
            current = Some((w, false));
            continue;
        }
        if rec.is_empty() {
            finish(current.take());
            continue;
        }
        let Some((w, bare)) = current.as_mut() else {
            continue;
        };
        let value = value.map(str::to_string);
        match key {
            "HEAD" => w.head = value.filter(|h| !h.bytes().all(|b| b == b'0')),
            "branch" => {
                w.branch = value.map(|b| b.strip_prefix("refs/heads/").unwrap_or(&b).to_string())
            }
            "detached" => w.detached = true,
            "bare" => *bare = true,
            "locked" => {
                w.locked = true;
                w.lock_reason = value.filter(|r| !r.trim().is_empty());
            }
            "prunable" => w.prunable = true,
            _ => {}
        }
    }
    finish(current.take());
    out
}

/// Parses `for-each-ref --format=%(refname:lstrip=2)%00%(upstream:short)%00%(upstream:track)`:
/// each branch's upstream and whether that upstream is gone.
pub(crate) fn parse_upstreams(bytes: &[u8]) -> HashMap<String, (Option<String>, bool)> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\0');
            let name = f.next().filter(|n| !n.is_empty())?.to_string();
            let upstream = f.next().filter(|u| !u.is_empty()).map(str::to_string);
            let gone = f.next() == Some("[gone]");
            Some((name, (upstream, gone)))
        })
        .collect()
}

pub(crate) fn merged_state(is_ancestor: Option<bool>, upstream_gone: bool) -> MergedState {
    match is_ancestor {
        None => MergedState::Unknown,
        Some(true) => MergedState::Merged,
        Some(false) if upstream_gone => MergedState::ProbablyMerged,
        Some(false) => MergedState::NotMerged,
    }
}

/// The branch worktrees are compared against (design section 3.9).
pub(crate) fn resolve_primary(
    configured: Option<&str>,
    origin_head: Option<&str>,
    has_local: impl Fn(&str) -> bool,
    has_origin: impl Fn(&str) -> bool,
) -> Option<String> {
    let exists = |b: &str| has_local(b) || has_origin(b);
    configured
        .filter(|b| exists(b))
        .or(origin_head.filter(|b| exists(b)))
        .or_else(|| FALLBACK_PRIMARIES.into_iter().find(|b| exists(b)))
        .map(str::to_string)
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// The main worktree first, then the rest by folder name ignoring case.
pub(crate) fn sort_worktrees(list: &mut [Worktree]) {
    list.sort_by_cached_key(|w| (!w.main, folder_name(&w.path), w.path.to_lowercase()));
}

/// Git prints `C:/x`; the front end compares and shows native paths.
fn native(path: &str) -> String {
    crate::files::normalize(path)
        .map(|p| display(&p))
        .unwrap_or_else(|_| path.to_string())
}

/// The primary branch and the full ref to compare against.
struct Primary {
    info: PrimaryBranch,
    compare_ref: Option<String>,
}

fn has_ref(g: &Git, name: &str) -> bool {
    g.read(["show-ref", "--verify", "-q", name])
        .is_ok_and(|o| o.ok)
}

fn primary(g: &Git, configured: Option<&str>) -> Result<Primary, String> {
    let has_local = |b: &str| has_ref(g, &format!("refs/heads/{b}"));
    let has_origin = |b: &str| has_ref(g, &format!("refs/remotes/origin/{b}"));
    let out = g.read(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"])?;
    let origin_head = out
        .ok
        .then(|| out.stdout())
        .and_then(|s| s.strip_prefix("origin/").map(str::to_string))
        .filter(|s| !s.is_empty());
    let branch = resolve_primary(configured, origin_head.as_deref(), has_local, has_origin);
    let (comparison, compare_ref) = match &branch {
        Some(b) if has_origin(b) => (
            Some(format!("origin/{b}")),
            Some(format!("refs/remotes/origin/{b}")),
        ),
        Some(b) => (Some(b.clone()), Some(format!("refs/heads/{b}"))),
        None => (None, None),
    };
    Ok(Primary {
        info: PrimaryBranch {
            branch,
            comparison,
            configured: configured.map(str::to_string),
        },
        compare_ref,
    })
}

fn list_raw(g: &Git) -> Result<Vec<RawWorktree>, String> {
    let out = g.read(["worktree", "list", "--porcelain", "-z"])?;
    if !out.ok {
        return Err(out.message());
    }
    Ok(parse_worktrees(&out.stdout))
}

/// The main worktree's path, which keys the repo in repos.json; a bare repo has none, so the
/// folder git ran in stands in.
fn main_path(g: &Git, raw: &[RawWorktree]) -> String {
    raw.iter()
        .find(|w| w.main)
        .map(|w| native(&w.path))
        .unwrap_or_else(|| display(g.root()))
}

fn upstreams(g: &Git) -> Result<HashMap<String, (Option<String>, bool)>, String> {
    let out = g.read([
        "for-each-ref",
        "--format=%(refname:lstrip=2)%00%(upstream:short)%00%(upstream:track)",
        "refs/heads",
    ])?;
    if !out.ok {
        return Err(out.message());
    }
    Ok(parse_upstreams(&out.stdout))
}

/// Exit 0 is an ancestor, 1 is not; anything else is git failing.
fn is_ancestor(g: &Git, head: &str, compare_ref: &str) -> Result<bool, String> {
    let out = g.read(["merge-base", "--is-ancestor", head, compare_ref])?;
    match out.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(out.message()),
    }
}

/// Ahead, behind, and merged state of `head` against the comparison ref.
fn compare(
    g: &Git,
    head: Option<&str>,
    compare_ref: Option<&str>,
    upstream_gone: bool,
) -> Result<(u32, u32, MergedState), String> {
    let (Some(head), Some(compare_ref)) = (head, compare_ref) else {
        return Ok((0, 0, merged_state(None, upstream_gone)));
    };
    let range = format!("{head}...{compare_ref}");
    let counts = Git::ok(g.read(["rev-list", "--left-right", "--count", &range, "--"])?)?;
    let mut n = counts
        .split_whitespace()
        .map(|c| c.parse::<u32>().unwrap_or(0));
    let (ahead, behind) = (n.next().unwrap_or(0), n.next().unwrap_or(0));
    let merged = merged_state(Some(is_ancestor(g, head, compare_ref)?), upstream_gone);
    Ok((ahead, behind, merged))
}

fn worktrees_from(
    g: &Git,
    raw: Vec<RawWorktree>,
    configured: Option<&str>,
) -> Result<WorktreeList, String> {
    let primary = primary(g, configured)?;
    let ups = upstreams(g)?;
    let local_branches =
        Git::ok(g.read(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"])?)?
            .lines()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string)
            .collect();
    let mut worktrees = Vec::with_capacity(raw.len());
    for w in raw {
        let path = native(&w.path);
        let prunable = w.prunable || !Path::new(&path).is_dir();
        let (upstream, upstream_gone) = w
            .branch
            .as_ref()
            .and_then(|b| ups.get(b).cloned())
            .unwrap_or_default();
        let counted = compare(
            g,
            w.head.as_deref(),
            primary.compare_ref.as_deref(),
            upstream_gone,
        );
        // A worktree whose folder is gone may point at a commit that was since collected.
        let (ahead, behind, merged) = match counted {
            Err(_) if prunable => (0, 0, MergedState::Unknown),
            other => other?,
        };
        worktrees.push(Worktree {
            path,
            head: w.head,
            branch: w.branch,
            detached: w.detached,
            main: w.main,
            locked: w.locked,
            lock_reason: w.lock_reason,
            prunable,
            upstream,
            upstream_gone,
            ahead,
            behind,
            merged,
        });
    }
    sort_worktrees(&mut worktrees);
    Ok(WorktreeList {
        primary: primary.info,
        local_branches,
        worktrees,
    })
}

pub(crate) fn worktrees(g: &Git, configured: Option<&str>) -> Result<WorktreeList, String> {
    worktrees_from(g, list_raw(g)?, configured)
}

pub(crate) fn primary_branch(g: &Git, configured: Option<&str>) -> Result<PrimaryBranch, String> {
    Ok(primary(g, configured)?.info)
}

pub(crate) fn main_worktree_path(g: &Git) -> Result<String, String> {
    Ok(main_path(g, &list_raw(g)?))
}

fn head_commit(g: &Git) -> Result<Option<HeadCommit>, String> {
    let out = g.read(["log", "-1", "--format=%h%x1f%s%x1f%ct", "HEAD", "--"])?;
    if !out.ok {
        return Ok(None);
    }
    let text = out.stdout();
    let mut f = text.split('\x1f');
    let (Some(hash), Some(subject), Some(time)) = (f.next(), f.next(), f.next()) else {
        return Ok(None);
    };
    Ok(Some(HeadCommit {
        hash: hash.to_string(),
        subject: subject.to_string(),
        time: time.trim().parse::<i64>().unwrap_or(0) * 1000,
    }))
}

/// `(staged, changed, untracked, status)` of the worktree `g` runs in; `changed` counts
/// unstaged and conflicted entries.
fn status_counts(g: &Git) -> Result<(u32, u32, u32, crate::git::GitStatus), String> {
    let out = g.read([
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
    ])?;
    if !out.ok {
        return Err(out.message());
    }
    let s = parse_status(&out.stdout);
    let staged = s.staged.len() as u32;
    let changed = (s.unstaged.len() + s.conflicted.len()) as u32;
    let untracked = s.untracked.len() as u32;
    Ok((staged, changed, untracked, s))
}

/// `g` runs in the worktree itself.
pub(crate) fn worktree_detail(g: &Git, configured: Option<&str>) -> Result<WorktreeDetail, String> {
    let (staged, changed, untracked, status) = status_counts(g)?;
    let head = head_commit(g)?;
    let head_hash = {
        let out = g.read(["rev-parse", "--verify", "-q", "HEAD"])?;
        out.ok.then(|| out.stdout())
    };
    let upstream_gone = match &status.branch {
        Some(b) => upstreams(g)?.get(b).is_some_and(|(_, gone)| *gone),
        None => false,
    };
    let primary = primary(g, configured)?;
    let (ahead, behind, merged) = compare(
        g,
        head_hash.as_deref(),
        primary.compare_ref.as_deref(),
        upstream_gone,
    )?;
    Ok(WorktreeDetail {
        path: display(g.root()),
        branch: status.branch,
        head,
        comparison: primary.info.comparison,
        ahead,
        behind,
        merged,
        upstream: status.upstream,
        upstream_gone,
        upstream_ahead: status.ahead,
        upstream_behind: status.behind,
        staged,
        changed,
        untracked,
    })
}

/// `g` runs in the repo root. Refuses the main, locked, and dirty worktrees, and a branch
/// delete unless the branch is merged.
pub(crate) fn worktree_remove(
    g: &Git,
    path: &str,
    delete_branch: bool,
    configured: Option<&str>,
) -> Result<RemoveResult, String> {
    let list = worktrees(g, configured)?;
    let Some(w) = list.worktrees.iter().find(|w| same_root(&w.path, path)) else {
        return Err(format!("{path} is not a worktree of this repo"));
    };
    if w.main {
        return Err("The main worktree cannot be deleted".into());
    }
    if w.locked {
        return Err(match &w.lock_reason {
            Some(reason) => format!("Locked: {reason}"),
            None => "The worktree is locked".into(),
        });
    }
    let branch = if delete_branch {
        let Some(branch) = w.branch.clone() else {
            return Err("The worktree has no branch to delete".into());
        };
        if w.merged != MergedState::Merged {
            return Err(format!("Branch {branch} is not merged, so it is kept"));
        }
        Some(branch)
    } else {
        None
    };
    if w.prunable {
        // There is no folder, so there is nothing to check for changes; prune only clears
        // records whose folder is missing, and a locked one was refused above.
        let out = g.write(["worktree", "prune"])?;
        if !out.ok {
            return Err(out.message());
        }
        let still_listed = list_raw(g)?
            .iter()
            .any(|r| same_root(&native(&r.path), &w.path));
        if still_listed {
            return Err(if out.stdout.is_empty() && out.stderr.is_empty() {
                "Git kept the worktree record".to_string()
            } else {
                format!("Git kept the worktree record: {}", out.message())
            });
        }
    } else {
        let (staged, changed, untracked, _) = status_counts(&g.at(w.path.clone().into()))?;
        if staged + changed + untracked > 0 {
            return Err(format!(
                "Not clean: {staged} staged, {changed} changed, {untracked} untracked"
            ));
        }
        let out = g.write(["worktree", "remove", w.path.as_str()])?;
        if !out.ok {
            return Err(out.message());
        }
    }
    let branch_error = match branch {
        Some(b) => {
            let out = g.write(["branch", "-d", b.as_str()])?;
            (!out.ok).then(|| out.message())
        }
        None => None,
    };
    Ok(RemoveResult { branch_error })
}

fn configured_for(app: &AppHandle, g: &Git) -> Result<Option<String>, String> {
    let main = main_worktree_path(g)?;
    Ok(configured_primary_branch(app, Path::new(&main)))
}

#[tauri::command]
pub async fn git_worktrees(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    root: String,
) -> Result<WorktreeList, String> {
    run(settings, root, move |g| {
        let raw = list_raw(g)?;
        let configured = configured_primary_branch(&app, Path::new(&main_path(g, &raw)));
        worktrees_from(g, raw, configured.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_worktree_detail(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    path: String,
) -> Result<WorktreeDetail, String> {
    run(settings, path, move |g| {
        let configured = configured_for(&app, g)?;
        worktree_detail(g, configured.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_primary_branch(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    root: String,
) -> Result<PrimaryBranch, String> {
    run(settings, root, move |g| {
        let configured = configured_for(&app, g)?;
        primary_branch(g, configured.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_worktree_remove(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    root: String,
    path: String,
    delete_branch: bool,
) -> Result<RemoveResult, String> {
    run(settings, root, move |g| {
        let configured = configured_for(&app, g)?;
        worktree_remove(g, &path, delete_branch, configured.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{Repo, commit_file, repo, sh, temp_dir, with_bare_remote};
    use std::{fs, path::PathBuf};

    #[test]
    fn git_worktrees_parse_porcelain() {
        let raw = concat!(
            "worktree C:/r\0HEAD aaaa\0branch refs/heads/main\0\0",
            "worktree C:/r-d\0HEAD bbbb\0detached\0\0",
            "worktree C:/r-l\0HEAD cccc\0branch refs/heads/l\0locked\0\0",
            "worktree C:/r-lr\0HEAD dddd\0branch refs/heads/lr\0locked on a usb drive\0\0",
            "worktree C:/r-p\0HEAD eeee\0branch refs/heads/feature/p\0",
            "prunable gitdir file points to non-existent location\0\0",
        );
        let w = parse_worktrees(raw.as_bytes());
        assert_eq!(w.len(), 5);
        assert_eq!(
            w[0],
            RawWorktree {
                path: "C:/r".into(),
                head: Some("aaaa".into()),
                branch: Some("main".into()),
                main: true,
                ..RawWorktree::default()
            }
        );
        assert!(w[1].detached && w[1].branch.is_none() && !w[1].main);
        assert!(w[2].locked && w[2].lock_reason.is_none());
        assert_eq!(w[3].lock_reason.as_deref(), Some("on a usb drive"));
        assert!(w[4].prunable && !w[4].locked);
        assert_eq!(w[4].branch.as_deref(), Some("feature/p"));

        let bare = "worktree C:/b.git\0bare\0\0worktree C:/x\0HEAD ffff\0branch refs/heads/x\0\0";
        let w = parse_worktrees(bare.as_bytes());
        assert_eq!(w.len(), 1);
        assert_eq!((w[0].path.as_str(), w[0].main), ("C:/x", false));

        let unborn = format!(
            "worktree C:/u\0HEAD {}\0branch refs/heads/main\0\0",
            "0".repeat(40)
        );
        assert_eq!(parse_worktrees(unborn.as_bytes())[0].head, None);
    }

    #[test]
    fn git_worktrees_parse_upstreams() {
        let raw = concat!(
            "main\0origin/main\0\n",
            "squashed\0origin/squashed\0[gone]\n",
            "ahead\0origin/ahead\0[ahead 1]\n",
            "local\0\0\n",
        );
        let u = parse_upstreams(raw.as_bytes());
        assert_eq!(u["main"], (Some("origin/main".into()), false));
        assert_eq!(u["squashed"], (Some("origin/squashed".into()), true));
        assert_eq!(u["ahead"], (Some("origin/ahead".into()), false));
        assert_eq!(u["local"], (None, false));
        assert_eq!(u.len(), 4);
    }

    #[test]
    fn git_worktrees_merged_state_table() {
        use MergedState::*;
        assert_eq!(merged_state(None, false), Unknown);
        assert_eq!(merged_state(None, true), Unknown);
        assert_eq!(merged_state(Some(true), false), Merged);
        assert_eq!(merged_state(Some(true), true), Merged);
        assert_eq!(merged_state(Some(false), true), ProbablyMerged);
        assert_eq!(merged_state(Some(false), false), NotMerged);
        let json = serde_json::to_string(&[Merged, ProbablyMerged, NotMerged, Unknown]).unwrap();
        assert_eq!(json, r#"["merged","probablyMerged","notMerged","unknown"]"#);
    }

    #[test]
    fn git_worktrees_resolve_primary_fallbacks() {
        let set = |names: &'static [&'static str]| move |b: &str| names.contains(&b);
        let none = |_: &str| false;
        assert_eq!(
            resolve_primary(Some("trunk"), Some("main"), set(&["trunk"]), none).as_deref(),
            Some("trunk")
        );
        assert_eq!(
            resolve_primary(Some("trunk"), Some("main"), none, set(&["trunk", "main"])).as_deref(),
            Some("trunk")
        );
        assert_eq!(
            resolve_primary(Some("gone"), Some("main"), set(&["main"]), set(&["main"])).as_deref(),
            Some("main")
        );
        assert_eq!(
            resolve_primary(None, None, set(&["master", "main"]), none).as_deref(),
            Some("main")
        );
        assert_eq!(
            resolve_primary(None, None, set(&["master"]), set(&["develop"])).as_deref(),
            Some("develop")
        );
        assert_eq!(
            resolve_primary(None, None, set(&["dev", "develop"]), none).as_deref(),
            Some("dev")
        );
        assert_eq!(resolve_primary(None, None, set(&["trunk"]), none), None);
    }

    #[test]
    fn git_worktrees_sort_main_first_then_folder() {
        let wt = |path: &str, main: bool| Worktree {
            path: path.into(),
            main,
            ..Worktree::default()
        };
        let mut list = vec![
            wt("/z/beta", false),
            wt("/a/zeta-main", true),
            wt("/y/Alpha", false),
            wt("/x/gamma", false),
        ];
        sort_worktrees(&mut list);
        let order: Vec<&str> = list.iter().map(|w| w.path.as_str()).collect();
        assert_eq!(
            order,
            [
                "/a/zeta-main",
                "/y/Alpha",
                "/z/beta",
                "/x/gamma"
            ]
        );
    }

    /// A fresh folder path for a linked worktree, removed with the repo.
    fn wt_dir(g: &Repo, tag: &str) -> PathBuf {
        let dir = temp_dir(tag);
        fs::remove_dir_all(&dir).unwrap();
        g.remotes.borrow_mut().push(dir.clone());
        dir
    }

    fn add(g: &Repo, tag: &str, args: &[&str]) -> PathBuf {
        let dir = wt_dir(g, tag);
        let path = display(&dir);
        let mut all = vec!["worktree", "add", "-q", path.as_str()];
        all.extend_from_slice(args);
        sh(g.root(), &all);
        dir
    }

    fn find<'a>(list: &'a WorktreeList, dir: &Path) -> &'a Worktree {
        list.worktrees
            .iter()
            .find(|w| same_root(&w.path, &display(dir)))
            .unwrap_or_else(|| panic!("{dir:?} not in {:?}", list.worktrees))
    }

    fn has_branch(g: &Git, b: &str) -> bool {
        has_ref(g, &format!("refs/heads/{b}"))
    }

    fn published(tag: &str) -> Repo {
        let g = repo(tag);
        with_bare_remote(&g);
        commit_file(&g, "a.txt", "1\n", "first");
        sh(g.root(), &["push", "-q", "-u", "origin", "main"]);
        g
    }

    #[test]
    fn git_worktrees_primary_resolution() {
        let g = repo("wt-primary");
        with_bare_remote(&g);
        commit_file(&g, "a.txt", "1\n", "first");
        sh(g.root(), &["branch", "master"]);
        sh(g.root(), &["push", "-q", "origin", "main:develop"]);
        // `develop` exists only on origin and comes before the local `main` in the order.
        let p = primary_branch(&g, None).unwrap();
        assert_eq!(p.branch.as_deref(), Some("develop"));
        assert_eq!(p.comparison.as_deref(), Some("origin/develop"));
        assert_eq!(p.configured, None);

        let p = primary_branch(&g, Some("master")).unwrap();
        assert_eq!(
            (
                p.branch.as_deref(),
                p.comparison.as_deref(),
                p.configured.as_deref()
            ),
            (Some("master"), Some("master"), Some("master"))
        );
        let p = primary_branch(&g, Some("deleted")).unwrap();
        assert_eq!(p.branch.as_deref(), Some("develop"));
        assert_eq!(p.configured.as_deref(), Some("deleted"));

        sh(g.root(), &["push", "-q", "origin", "main"]);
        sh(g.root(), &["remote", "set-head", "origin", "main"]);
        let p = primary_branch(&g, None).unwrap();
        assert_eq!(p.branch.as_deref(), Some("main"));
        assert_eq!(p.comparison.as_deref(), Some("origin/main"));

        let lone = repo("wt-lone");
        commit_file(&lone, "a.txt", "1\n", "first");
        sh(lone.root(), &["branch", "-m", "trunk"]);
        let p = primary_branch(&lone, None).unwrap();
        assert_eq!((p.branch, p.comparison), (None, None));
        let list = worktrees(&lone, None).unwrap();
        assert_eq!(list.worktrees[0].merged, MergedState::Unknown);
        let p = primary_branch(&lone, Some("trunk")).unwrap();
        assert_eq!(p.comparison.as_deref(), Some("trunk"));
    }

    /// main pushed; `fresh` (no own commits), `merged` (merged into origin/main), `squashed`
    /// (squash-merged, remote branch deleted, pruned), and `wip` (one unmerged commit).
    fn merge_scenario(tag: &str) -> (Repo, [PathBuf; 4]) {
        let g = published(tag);
        let wip = add(&g, "wt-wip", &["-b", "wip"]);
        commit_file(&g.at(wip.clone()), "wip.txt", "wip\n", "wip");
        let merged = add(&g, "wt-merged", &["-b", "merged"]);
        commit_file(&g.at(merged.clone()), "m.txt", "m\n", "to merge");
        sh(g.root(), &["merge", "-q", "--ff-only", "merged"]);
        let squashed = add(&g, "wt-squash", &["-b", "squashed"]);
        commit_file(&g.at(squashed.clone()), "s.txt", "s\n", "to squash");
        sh(&squashed, &["push", "-q", "-u", "origin", "squashed"]);
        sh(g.root(), &["merge", "-q", "--squash", "squashed"]);
        sh(g.root(), &["commit", "-q", "-m", "squashed"]);
        sh(g.root(), &["push", "-q", "origin", "main"]);
        sh(g.root(), &["push", "-q", "origin", "--delete", "squashed"]);
        sh(g.root(), &["fetch", "-q", "--prune"]);
        let fresh = add(&g, "wt-fresh", &["-b", "fresh"]);
        (g, [fresh, merged, squashed, wip])
    }

    #[test]
    fn git_worktrees_merged_states() {
        let (g, [fresh, merged, squashed, wip]) = merge_scenario("wt-merge");
        let list = worktrees(&g, None).unwrap();
        let main = &list.worktrees[0];
        // Native separators: Git prints C:/x on Windows, which the front end would not match.
        assert!(main.main && (!cfg!(windows) || !main.path.contains('/')), "{}", main.path);
        assert_eq!(main_worktree_path(&g.at(wip.clone())).unwrap(), main.path);
        assert_eq!(find(&list, &fresh).merged, MergedState::Merged);
        assert_eq!(find(&list, &merged).merged, MergedState::Merged);
        let s = find(&list, &squashed);
        assert_eq!(s.merged, MergedState::ProbablyMerged);
        assert!(s.upstream_gone);
        assert_eq!((s.ahead, s.behind), (1, 1));
        let w = find(&list, &wip);
        assert_eq!(w.merged, MergedState::NotMerged);
        assert!(!w.upstream_gone && w.upstream.is_none());
        assert_eq!((w.ahead, w.behind), (1, 2));

        let d = worktree_detail(&g.at(squashed.clone()), None).unwrap();
        assert_eq!(d.merged, MergedState::ProbablyMerged);
        assert!(d.upstream_gone);
        assert_eq!(d.branch.as_deref(), Some("squashed"));
        assert_eq!(d.comparison.as_deref(), Some("origin/main"));
        let head = d.head.unwrap();
        assert_eq!(head.subject, "to squash");
        assert_eq!(head.hash.len(), 7);
        assert!(head.time > 1_600_000_000_000);

        fs::write(wip.join("wip.txt"), "edited\n").unwrap();
        fs::write(wip.join("new.txt"), "new\n").unwrap();
        fs::write(wip.join("staged.txt"), "staged\n").unwrap();
        sh(&wip, &["add", "--", "staged.txt"]);
        let d = worktree_detail(&g.at(wip.clone()), None).unwrap();
        assert_eq!((d.staged, d.changed, d.untracked), (1, 1, 1));
        assert_eq!(
            (d.ahead, d.behind, d.merged),
            (1, 2, MergedState::NotMerged)
        );
        assert_eq!((d.upstream, d.upstream_gone), (None, false));

        let d = worktree_detail(&g, None).unwrap();
        assert_eq!(d.upstream.as_deref(), Some("origin/main"));
        assert_eq!((d.upstream_ahead, d.upstream_behind), (0, 0));
        assert_eq!(d.merged, MergedState::Merged);
    }

    #[test]
    fn git_worktrees_remove_refuses_main_locked_and_strangers() {
        let g = published("wt-refuse");
        let locked = add(&g, "wt-lock2", &["-b", "locked"]);
        sh(g.root(), &["worktree", "lock", &display(&locked)]);

        let err = worktree_remove(&g, &display(g.root()), false, None).unwrap_err();
        assert_eq!(err, "The main worktree cannot be deleted");
        let err = worktree_remove(&g, &display(&locked), false, None).unwrap_err();
        assert_eq!(err, "The worktree is locked");
        sh(g.root(), &["worktree", "unlock", &display(&locked)]);
        sh(
            g.root(),
            &["worktree", "lock", "--reason", "usb", &display(&locked)],
        );
        let err = worktree_remove(&g, &display(&locked), false, None).unwrap_err();
        assert_eq!(err, "Locked: usb");
        let stranger = temp_dir("wt-none");
        let err = worktree_remove(&g, &display(&stranger), false, None).unwrap_err();
        assert!(err.contains("not a worktree of this repo"), "{err}");
        let _ = fs::remove_dir_all(&stranger);
    }

    #[test]
    fn git_worktrees_remove_refuses_dirty_and_unmerged_then_removes_a_merged_one() {
        let g = published("wt-remove");
        let wip = add(&g, "wt-wip", &["-b", "wip"]);
        commit_file(&g.at(wip.clone()), "wip.txt", "wip\n", "wip");
        let fresh = add(&g, "wt-fresh", &["-b", "fresh"]);

        fs::write(fresh.join("scratch.txt"), "x\n").unwrap();
        let err = worktree_remove(&g, &display(&fresh), false, None).unwrap_err();
        assert_eq!(err, "Not clean: 0 staged, 0 changed, 1 untracked");
        assert!(fresh.is_dir());

        let err = worktree_remove(&g, &display(&wip), true, None).unwrap_err();
        assert!(err.contains("not merged"), "{err}");
        assert!(wip.is_dir() && has_branch(&g, "wip"));

        // Forward slashes and other case still name the worktree.
        fs::remove_file(fresh.join("scratch.txt")).unwrap();
        let spelled = display(&fresh).replace('\\', "/").to_uppercase();
        let r = worktree_remove(&g, &spelled, true, None).unwrap();
        assert_eq!(r, RemoveResult { branch_error: None });
        assert!(!fresh.exists() && !has_branch(&g, "fresh"));
        let list = worktrees(&g, None).unwrap();
        assert!(!list.worktrees.iter().any(|w| same_root(&w.path, &display(&fresh))));
    }

    #[test]
    fn git_worktrees_remove_prunable_through_prune() {
        let g = published("wt-prune");
        let gone = add(&g, "wt-gone", &["-b", "gone"]);
        let kept = add(&g, "wt-kept", &["-b", "kept"]);
        fs::remove_dir_all(&gone).unwrap();
        assert!(find(&worktrees(&g, None).unwrap(), &gone).prunable);

        let r = worktree_remove(&g, &display(&gone), true, None).unwrap();
        assert_eq!(r.branch_error, None);
        let list = worktrees(&g, None).unwrap();
        assert!(
            !list
                .worktrees
                .iter()
                .any(|w| same_root(&w.path, &display(&gone)))
        );
        assert!(!has_branch(&g, "gone"));
        find(&list, &kept);
        assert_eq!(list.worktrees.len(), 2);
    }

    #[test]
    fn git_worktrees_serialize_camel_case() {
        let list = WorktreeList {
            primary: PrimaryBranch::default(),
            local_branches: vec!["main".into()],
            worktrees: vec![Worktree::default()],
        };
        let v = serde_json::to_value(&list).unwrap();
        assert!(v.get("localBranches").is_some());
        let w = &v["worktrees"][0];
        for key in [
            "path",
            "head",
            "branch",
            "detached",
            "main",
            "locked",
            "lockReason",
            "prunable",
            "upstream",
            "upstreamGone",
            "ahead",
            "behind",
            "merged",
        ] {
            assert!(w.get(key).is_some(), "{key}");
        }
        assert_eq!(w["merged"], "unknown");
        let r = serde_json::to_value(RemoveResult { branch_error: None }).unwrap();
        assert_eq!(r, serde_json::json!({ "branchError": null }));
    }
}
