//! The Git pane's commands (design section 3.9).
//!
//! Every command runs `git -C <root> ...` with an argument list, never through a shell, and
//! with paths after `--`.

use std::{
    ffi::OsStr,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    thread,
};

use serde::Serialize;
use tauri::State;

use crate::{profiles, settings::SettingsState};

const DIFF_CAP: usize = 1024 * 1024;
const NOT_FOUND: &str = "git was not found on PATH or beside Git Bash";

#[cfg(windows)]
const GIT_EXE: &str = "git.exe";
#[cfg(not(windows))]
const GIT_EXE: &str = "git";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    orig_path: Option<String>,
    status: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    branch: Option<String>,
    oid: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    staged: Vec<GitFileEntry>,
    unstaged: Vec<GitFileEntry>,
    untracked: Vec<GitFileEntry>,
    conflicted: Vec<GitFileEntry>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    text: String,
    truncated: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    hash: String,
    subject: String,
    author: String,
    time: i64,
    pushed: bool,
}

fn entry(path: &str, orig_path: Option<&str>, status: char) -> GitFileEntry {
    GitFileEntry {
        path: path.to_string(),
        orig_path: orig_path.map(str::to_string),
        status: status.to_string(),
    }
}

/// Parses `status --porcelain=v2 --branch -z` output.
fn parse_status(bytes: &[u8]) -> GitStatus {
    let text = String::from_utf8_lossy(bytes);
    let mut records = text.split('\0');
    let mut s = GitStatus::default();
    while let Some(rec) = records.next() {
        if let Some(header) = rec.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => s.oid = (value != "(initial)").then(|| value.to_string()),
                "branch.head" => s.branch = (value != "(detached)").then(|| value.to_string()),
                "branch.upstream" => s.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            s.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            s.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let (kind, fields) = match rec.split_once(' ') {
            Some(kv) => kv,
            None => continue,
        };
        match kind {
            "1" | "2" => {
                // XY sub mH mI mW hH hI [Xscore] path; the path is last and may hold spaces.
                let n = if kind == "1" { 8 } else { 9 };
                let parts: Vec<&str> = fields.splitn(n, ' ').collect();
                if parts.len() < n {
                    continue;
                }
                let orig = if kind == "2" { records.next() } else { None };
                let path = parts[n - 1];
                let mut xy = parts[0].chars();
                let (x, y) = (xy.next().unwrap_or('.'), xy.next().unwrap_or('.'));
                if x != '.' {
                    s.staged.push(entry(path, orig, x));
                }
                if y != '.' {
                    s.unstaged.push(entry(path, orig, y));
                }
            }
            "u" => {
                // XY sub m1 m2 m3 mW h1 h2 h3 path
                if let Some(path) = fields.splitn(10, ' ').nth(9) {
                    s.conflicted.push(entry(path, None, 'U'));
                }
            }
            "?" => s.untracked.push(entry(fields, None, '?')),
            _ => {}
        }
    }
    s
}

/// Parses `log -z --format=%H%x1f%s%x1f%an%x1f%ct`.
fn parse_log(bytes: &[u8], unpushed: &[&str]) -> Vec<GitCommit> {
    String::from_utf8_lossy(bytes)
        .split('\0')
        .filter_map(|rec| {
            let mut f = rec.trim_start_matches('\n').split('\x1f');
            let hash = f.next().filter(|h| !h.is_empty())?.to_string();
            let subject = f.next()?.to_string();
            let author = f.next()?.to_string();
            let time = f.next()?.trim().parse::<i64>().ok()? * 1000;
            let pushed = !unpushed.contains(&hash.as_str());
            Some(GitCommit {
                hash,
                subject,
                author,
                time,
                pushed,
            })
        })
        .collect()
}

fn on_path() -> Option<PathBuf> {
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    if let Some(p) = FOUND.get() {
        return Some(p.clone());
    }
    let path_var = std::env::var_os("PATH")?;
    let hit = std::env::split_paths(&path_var)
        .map(|d| d.join(GIT_EXE))
        .find(|p| p.is_file())?;
    Some(FOUND.get_or_init(|| hit).clone())
}

/// Git for Windows keeps `git.exe` in `cmd\` beside the `bin\` holding `bash.exe`, and a copy
/// in `bin\` itself.
fn beside_bash(bash: &Path) -> Option<PathBuf> {
    let bin = bash.parent()?;
    let candidates = [
        bin.parent().map(|r| r.join("cmd").join(GIT_EXE)),
        Some(bin.join(GIT_EXE)),
    ];
    candidates.into_iter().flatten().find(|p| p.is_file())
}

fn locate_git(settings: &SettingsState) -> Result<PathBuf, String> {
    if let Some(p) = on_path() {
        return Ok(p);
    }
    profiles::available_profiles(&settings.current().shell)
        .into_iter()
        .find(|p| p.id == profiles::GIT_BASH)
        .and_then(|p| beside_bash(Path::new(&p.path)))
        .ok_or_else(|| NOT_FOUND.to_string())
}

fn check_root(root: &str) -> Result<PathBuf, String> {
    let dir = crate::files::normalize(root)?;
    if !dir.is_dir() {
        return Err(format!("{root} is not a folder"));
    }
    Ok(dir)
}

fn check_paths(paths: &[String]) -> Result<(), String> {
    for p in paths {
        let bad = p.is_empty()
            || Path::new(p)
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir));
        if bad {
            return Err(format!("not a repo-relative path: {p}"));
        }
    }
    Ok(())
}

/// The hash is passed as a revision, so anything but hex could be read as an option.
fn check_hash(hash: &str) -> Result<(), String> {
    if (4..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("not a commit hash: {hash}"))
    }
}

struct Output {
    ok: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

impl Output {
    fn stdout(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }

    /// Git's combined stdout and stderr, trimmed, for showing a failure as is.
    fn message(&self) -> String {
        let out = String::from_utf8_lossy(&self.stdout);
        let err = String::from_utf8_lossy(&self.stderr);
        let joined = format!("{}\n{}", out.trim(), err.trim());
        let joined = joined.trim();
        if joined.is_empty() {
            format!("git exited with code {}", self.code.unwrap_or(-1))
        } else {
            joined.to_string()
        }
    }
}

struct Git {
    exe: PathBuf,
    root: PathBuf,
}

impl Git {
    fn open(settings: &SettingsState, root: &str) -> Result<Self, String> {
        let root = check_root(root)?;
        Ok(Self {
            exe: locate_git(settings)?,
            root,
        })
    }

    fn command<I, S>(&self, read: bool, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = Command::new(&self.exe);
        cmd.arg("-C")
            .arg(&self.root)
            .args(["-c", "core.quotePath=false"])
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            // Paths from the pane are file names, not pathspec patterns.
            .env("GIT_LITERAL_PATHSPECS", "1");
        if read {
            // Without this a status refresh takes the index lock and can make a git command
            // Claude runs at the same moment fail.
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        }
        // CREATE_NO_WINDOW, so no console flashes for each git run.
        crate::editors::hide_console(&mut cmd);
        cmd
    }

    fn exec(
        &self,
        mut cmd: Command,
        stdin: Option<&[u8]>,
        cap: Option<usize>,
    ) -> Result<Output, String> {
        cmd.stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
        let writer = stdin.map(|bytes| {
            let mut pipe = child.stdin.take().expect("stdin is piped");
            let bytes = bytes.to_vec();
            thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            })
        });
        let mut err_pipe = child.stderr.take().expect("stderr is piped");
        let err_reader = thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = err_pipe.read_to_end(&mut buf);
            buf
        });
        let mut out_pipe = child.stdout.take().expect("stdout is piped");
        let mut stdout = Vec::new();
        let mut truncated = false;
        match cap {
            Some(cap) => {
                (&mut out_pipe)
                    .take(cap as u64 + 1)
                    .read_to_end(&mut stdout)
                    .map_err(|e| e.to_string())?;
                if stdout.len() > cap {
                    truncated = true;
                    let _ = child.kill();
                    stdout.truncate(cap);
                    if let Some(i) = stdout.iter().rposition(|&b| b == b'\n') {
                        stdout.truncate(i + 1);
                    }
                }
            }
            None => {
                out_pipe
                    .read_to_end(&mut stdout)
                    .map_err(|e| e.to_string())?;
            }
        }
        drop(out_pipe);
        let status = child.wait().map_err(|e| e.to_string())?;
        if let Some(w) = writer {
            let _ = w.join();
        }
        let stderr = err_reader.join().unwrap_or_default();
        Ok(Output {
            ok: status.success(),
            code: status.code(),
            stdout,
            stderr,
            truncated,
        })
    }

    fn read<I, S>(&self, args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.exec(self.command(true, args), None, None)
    }

    fn write<I, S>(&self, args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.exec(self.command(false, args), None, None)
    }

    /// Succeeds only when git does, giving its trimmed stdout.
    fn ok(out: Output) -> Result<String, String> {
        if out.ok {
            Ok(out.stdout())
        } else {
            Err(out.message())
        }
    }

    fn has_head(&self) -> Result<bool, String> {
        Ok(self.read(["rev-parse", "--verify", "-q", "HEAD"])?.ok)
    }

    fn capped(&self, args: &[&OsStr], ok_codes: &[i32]) -> Result<GitDiff, String> {
        let out = self.exec(self.command(true, args), None, Some(DIFF_CAP))?;
        if !out.truncated && !out.ok && !out.code.is_some_and(|c| ok_codes.contains(&c)) {
            return Err(out.message());
        }
        Ok(GitDiff {
            text: String::from_utf8_lossy(&out.stdout).into_owned(),
            truncated: out.truncated,
        })
    }

    fn status(&self) -> Result<GitStatus, String> {
        let out = self.read([
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ])?;
        if !out.ok {
            return Err(out.message());
        }
        Ok(parse_status(&out.stdout))
    }

    fn stage(&self, paths: &[String]) -> Result<(), String> {
        check_paths(paths)?;
        if paths.is_empty() {
            return Ok(());
        }
        let args = ["add", "--"]
            .iter()
            .map(OsStr::new)
            .chain(paths.iter().map(OsStr::new));
        Self::ok(self.write(args)?).map(|_| ())
    }

    fn unstage(&self, paths: &[String]) -> Result<(), String> {
        check_paths(paths)?;
        if paths.is_empty() {
            return Ok(());
        }
        let head: &[&str] = if self.has_head()? {
            &["restore", "--staged", "--"]
        } else {
            &["rm", "--cached", "-q", "--"]
        };
        let args = head
            .iter()
            .map(OsStr::new)
            .chain(paths.iter().map(OsStr::new));
        Self::ok(self.write(args)?).map(|_| ())
    }

    fn diff(&self, path: &str, staged: bool) -> Result<GitDiff, String> {
        check_paths(&[path.to_string()])?;
        let p = OsStr::new(path);
        if !staged
            && !self
                .read([
                    OsStr::new("ls-files"),
                    OsStr::new("--error-unmatch"),
                    OsStr::new("--"),
                    p,
                ])?
                .ok
        {
            // Exit code 1 from --no-index means the files differ.
            let args = [
                "diff",
                "--no-index",
                "--no-color",
                "--no-ext-diff",
                "--",
                "/dev/null",
            ];
            let args: Vec<&OsStr> = args.iter().map(OsStr::new).chain([p]).collect();
            return self.capped(&args, &[1]);
        }
        let mut args: Vec<&OsStr> = ["diff", "--no-color", "--no-ext-diff"]
            .iter()
            .map(OsStr::new)
            .collect();
        if staged {
            args.push(OsStr::new("--cached"));
        }
        args.extend([OsStr::new("--"), p]);
        self.capped(&args, &[])
    }

    fn log(&self, count: u32) -> Result<Vec<GitCommit>, String> {
        if count == 0 || !self.has_head()? {
            return Ok(Vec::new());
        }
        let n = count.to_string();
        let log = Self::ok(self.read([
            "log",
            "-n",
            &n,
            "-z",
            "--format=%H%x1f%s%x1f%an%x1f%ct",
            "HEAD",
            "--",
        ])?)?;
        let unpushed =
            Self::ok(self.read(["rev-list", "-n", &n, "HEAD", "--not", "--remotes", "--"])?)?;
        let unpushed: Vec<&str> = unpushed.lines().map(str::trim).collect();
        Ok(parse_log(log.as_bytes(), &unpushed))
    }

    fn show(&self, hash: &str) -> Result<GitDiff, String> {
        check_hash(hash)?;
        let args: Vec<&OsStr> = [
            "show",
            "--no-color",
            "--no-ext-diff",
            "--format=fuller",
            hash,
            "--",
        ]
        .into_iter()
        .map(OsStr::new)
        .collect();
        self.capped(&args, &[])
    }

    fn commit(&self, message: &str) -> Result<(), String> {
        let out = self.exec(
            self.command(false, ["commit", "-F", "-"]),
            Some(message.as_bytes()),
            None,
        )?;
        if out.ok { Ok(()) } else { Err(out.message()) }
    }

    fn undo_commit(&self, expected_head: &str) -> Result<String, String> {
        check_hash(expected_head)?;
        // A prefix would let a different commit sharing it pass the moved-HEAD guard.
        if !matches!(expected_head.len(), 40 | 64) {
            return Err(format!("not a full commit hash: {expected_head}"));
        }
        let head = match self.read(["rev-parse", "--verify", "-q", "HEAD"])? {
            out if out.ok => out.stdout(),
            _ => return Err("There is no commit to undo".into()),
        };
        if !head
            .to_ascii_lowercase()
            .starts_with(&expected_head.to_ascii_lowercase())
        {
            return Err("HEAD has moved since the pane loaded; refresh and try again".into());
        }
        if !self.read(["rev-parse", "--verify", "-q", "HEAD~1"])?.ok {
            return Err("The first commit cannot be undone".into());
        }
        let git_dir = self
            .root
            .join(Self::ok(self.read(["rev-parse", "--git-dir"])?)?);
        let in_progress = [
            ("MERGE_HEAD", "merge"),
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
        ];
        if let Some((_, op)) = in_progress
            .iter()
            .find(|(name, _)| git_dir.join(name).exists())
        {
            return Err(format!("A {op} is in progress; finish or abort it first"));
        }
        let message = Self::ok(self.read(["log", "-1", "--format=%B", "HEAD", "--"])?)?;
        Self::ok(self.write(["reset", "--soft", "HEAD~1"])?)?;
        Ok(message)
    }
}

/// Runs the work on a blocking thread: a commit's hooks can take seconds, and status on a
/// large repo is not instant either.
async fn run<T, F>(settings: State<'_, SettingsState>, root: String, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Git) -> Result<T, String> + Send + 'static,
{
    let git = Git::open(&settings, &root)?;
    tauri::async_runtime::spawn_blocking(move || work(&git))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(
    settings: State<'_, SettingsState>,
    root: String,
) -> Result<GitStatus, String> {
    run(settings, root, |g| g.status()).await
}

#[tauri::command]
pub async fn git_stage(
    settings: State<'_, SettingsState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    run(settings, root, move |g| g.stage(&paths)).await
}

#[tauri::command]
pub async fn git_unstage(
    settings: State<'_, SettingsState>,
    root: String,
    paths: Vec<String>,
) -> Result<(), String> {
    run(settings, root, move |g| g.unstage(&paths)).await
}

#[tauri::command]
pub async fn git_diff(
    settings: State<'_, SettingsState>,
    root: String,
    path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    run(settings, root, move |g| g.diff(&path, staged)).await
}

#[tauri::command]
pub async fn git_log(
    settings: State<'_, SettingsState>,
    root: String,
    count: u32,
) -> Result<Vec<GitCommit>, String> {
    run(settings, root, move |g| g.log(count)).await
}

#[tauri::command]
pub async fn git_show(
    settings: State<'_, SettingsState>,
    root: String,
    hash: String,
) -> Result<GitDiff, String> {
    run(settings, root, move |g| g.show(&hash)).await
}

#[tauri::command]
pub async fn git_commit(
    settings: State<'_, SettingsState>,
    root: String,
    message: String,
) -> Result<(), String> {
    run(settings, root, move |g| g.commit(&message)).await
}

#[tauri::command]
pub async fn git_undo_commit(
    settings: State<'_, SettingsState>,
    root: String,
    expected_head: String,
) -> Result<String, String> {
    run(settings, root, move |g| g.undo_commit(&expected_head)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        fs,
        ops::Deref,
        sync::atomic::{AtomicU32, Ordering},
    };

    fn exe() -> PathBuf {
        on_path().expect("git on PATH for tests")
    }

    /// A fresh folder under the system temp dir; never inside an existing repo's tree.
    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("bashboard-git-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Runs git for test setup, panicking on failure.
    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new(exe())
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A temp repo, removed with any bare remotes it was given when the test ends.
    struct Repo {
        git: Git,
        remotes: RefCell<Vec<PathBuf>>,
    }

    impl Deref for Repo {
        type Target = Git;
        fn deref(&self) -> &Git {
            &self.git
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.git.root);
            for dir in self.remotes.get_mut() {
                let _ = fs::remove_dir_all(dir);
            }
        }
    }

    fn repo(tag: &str) -> Repo {
        let root = temp_dir(tag);
        sh(&root, &["init", "-q", "-b", "main"]);
        for (k, v) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", ".git/hooks"),
            ("core.autocrlf", "false"),
        ] {
            sh(&root, &["config", k, v]);
        }
        Repo {
            git: Git { exe: exe(), root },
            remotes: RefCell::new(Vec::new()),
        }
    }

    fn write(g: &Git, name: &str, text: &str) {
        fs::write(g.root.join(name), text).unwrap();
    }

    fn commit_file(g: &Git, name: &str, text: &str, msg: &str) -> String {
        write(g, name, text);
        sh(&g.root, &["add", "--", name]);
        sh(&g.root, &["commit", "-q", "-m", msg]);
        sh(&g.root, &["rev-parse", "HEAD"])
    }

    fn paths(entries: &[GitFileEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.path.as_str()).collect()
    }

    fn with_bare_remote(g: &Repo) {
        let bare = temp_dir("bare");
        sh(&bare, &["init", "-q", "--bare"]);
        sh(
            &g.root,
            &["remote", "add", "origin", &bare.to_string_lossy()],
        );
        g.remotes.borrow_mut().push(bare);
    }

    #[test]
    fn git_parse_status_reads_every_record_kind() {
        let raw = concat!(
            "# branch.oid 1234567890abcdef1234567890abcdef12345678\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -3\0",
            "1 M. N... 100644 100644 100644 aaaa bbbb src/staged file.rs\0",
            "1 .M N... 100644 100644 100644 aaaa aaaa unstaged.rs\0",
            "1 MM N... 100644 100644 100644 aaaa bbbb both.rs\0",
            "2 R. N... 100644 100644 100644 aaaa aaaa R100 new name.rs\0old name.rs\0",
            "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.rs\0",
            "? untracked dir/file.txt\0",
            "! ignored.log\0",
        );
        let s = parse_status(raw.as_bytes());
        assert_eq!(
            s.oid.as_deref(),
            Some("1234567890abcdef1234567890abcdef12345678")
        );
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (2, 3));
        assert_eq!(
            paths(&s.staged),
            ["src/staged file.rs", "both.rs", "new name.rs"]
        );
        assert_eq!(paths(&s.unstaged), ["unstaged.rs", "both.rs"]);
        assert_eq!(s.staged[2], entry("new name.rs", Some("old name.rs"), 'R'));
        assert_eq!(s.staged[0].status, "M");
        assert_eq!(s.conflicted, [entry("conflict.rs", None, 'U')]);
        assert_eq!(s.untracked, [entry("untracked dir/file.txt", None, '?')]);
    }

    #[test]
    fn git_parse_status_initial_and_detached() {
        let s = parse_status(b"# branch.oid (initial)\0# branch.head main\0? a.txt\0");
        assert_eq!(
            (s.oid, s.branch.as_deref(), s.upstream),
            (None, Some("main"), None)
        );
        assert_eq!((s.ahead, s.behind), (0, 0));
        let s = parse_status(b"# branch.oid abcdef1234\0# branch.head (detached)\0");
        assert_eq!((s.oid.as_deref(), s.branch), (Some("abcdef1234"), None));
    }

    #[test]
    fn git_validation_rejects_unsafe_input() {
        assert!(check_hash("abcd").is_ok());
        assert!(check_hash(&"a".repeat(64)).is_ok());
        for bad in ["abc", "--all", "HEAD", "abcg", &"a".repeat(65)] {
            assert!(check_hash(bad).is_err(), "{bad}");
        }
        assert!(check_paths(&["src/a.rs".into(), "./b".into()]).is_ok());
        for bad in ["", "../x", "a/../../x", "/etc/passwd", r"C:\x", r"\x"] {
            assert!(check_paths(&[bad.to_string()]).is_err(), "{bad}");
        }
        assert!(check_root("relative/path").is_err());
        assert!(
            check_root(
                &std::env::temp_dir()
                    .join("bashboard-git-no-such-folder")
                    .to_string_lossy()
            )
            .is_err()
        );
    }

    #[test]
    fn git_status_against_a_real_repo() {
        let g = repo("status");
        commit_file(&g, "a.txt", "one\n", "first");
        write(&g, "a.txt", "two\n");
        write(&g, "b.txt", "new\n");
        sh(&g.root, &["mv", "a.txt", "c.txt"]);
        let s = g.status().unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(s.oid.is_some());
        assert_eq!(s.staged, [entry("c.txt", Some("a.txt"), 'R')]);
        assert_eq!(s.unstaged, [entry("c.txt", Some("a.txt"), 'M')]);
        assert_eq!(paths(&s.untracked), ["b.txt"]);
        sh(&g.root, &["checkout", "-q", "--detach"]);
        assert_eq!(g.status().unwrap().branch, None);
    }

    #[test]
    fn git_stage_and_unstage_with_no_commits() {
        let g = repo("unborn");
        write(&g, "a.txt", "hi\n");
        write(&g, "b c.txt", "hi\n");
        let s = g.status().unwrap();
        assert_eq!(s.oid, None);
        assert_eq!(paths(&s.untracked), ["a.txt", "b c.txt"]);
        g.stage(&["a.txt".into(), "b c.txt".into()]).unwrap();
        let s = g.status().unwrap();
        assert_eq!(paths(&s.staged), ["a.txt", "b c.txt"]);
        assert!(s.untracked.is_empty());
        g.unstage(&["a.txt".into()]).unwrap();
        let s = g.status().unwrap();
        assert_eq!(paths(&s.staged), ["b c.txt"]);
        assert_eq!(paths(&s.untracked), ["a.txt"]);
        assert!(g.log(20).unwrap().is_empty());
    }

    #[test]
    fn git_unstage_after_a_commit_keeps_the_working_file() {
        let g = repo("unstage");
        commit_file(&g, "a.txt", "one\n", "first");
        write(&g, "a.txt", "two\n");
        g.stage(&["a.txt".into()]).unwrap();
        assert_eq!(paths(&g.status().unwrap().staged), ["a.txt"]);
        g.unstage(&["a.txt".into()]).unwrap();
        let s = g.status().unwrap();
        assert!(s.staged.is_empty());
        assert_eq!(paths(&s.unstaged), ["a.txt"]);
        assert_eq!(fs::read_to_string(g.root.join("a.txt")).unwrap(), "two\n");
    }

    #[test]
    fn git_diff_staged_unstaged_and_untracked() {
        let g = repo("diff");
        commit_file(&g, "a.txt", "one\n", "first");
        write(&g, "a.txt", "two\n");
        let d = g.diff("a.txt", false).unwrap();
        assert!(d.text.contains("-one\n+two"), "{}", d.text);
        assert!(!d.truncated);
        assert!(g.diff("a.txt", true).unwrap().text.is_empty());
        g.stage(&["a.txt".into()]).unwrap();
        assert!(g.diff("a.txt", true).unwrap().text.contains("+two"));

        write(&g, "new.txt", "fresh\nlines\n");
        let d = g.diff("new.txt", false).unwrap();
        assert!(d.text.contains("new file mode"), "{}", d.text);
        assert!(d.text.contains("+fresh\n+lines"), "{}", d.text);
    }

    #[test]
    fn git_diff_is_capped_at_one_mib() {
        let g = repo("cap");
        let line = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\n";
        write(&g, "big.txt", &line.repeat(2 * DIFF_CAP / line.len()));
        let d = g.diff("big.txt", false).unwrap();
        assert!(d.truncated);
        assert!(d.text.len() <= DIFF_CAP && d.text.len() > DIFF_CAP - 200);
        assert!(d.text.ends_with('\n'));
        assert!(!g.diff("big.txt", true).unwrap().truncated);
    }

    #[test]
    fn git_log_marks_pushed_commits() {
        let g = repo("log");
        with_bare_remote(&g);
        let first = commit_file(&g, "a.txt", "1\n", "first");
        sh(&g.root, &["push", "-q", "origin", "main"]);
        let second = commit_file(&g, "a.txt", "2\n", "second subject");
        let log = g.log(20).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(
            (log[0].hash.as_str(), log[0].pushed),
            (second.as_str(), false)
        );
        assert_eq!(log[0].subject, "second subject");
        assert_eq!(log[0].author, "Test");
        assert!(log[0].time > 1_600_000_000_000);
        assert_eq!(
            (log[1].hash.as_str(), log[1].pushed),
            (first.as_str(), true)
        );
        assert_eq!(g.log(1).unwrap().len(), 1);
    }

    #[test]
    fn git_show_gives_the_commit_diff() {
        let g = repo("show");
        let hash = commit_file(&g, "a.txt", "hello\n", "add a");
        let d = g.show(&hash).unwrap();
        assert!(d.text.starts_with(&format!("commit {hash}")), "{}", d.text);
        assert!(d.text.contains("CommitDate:") && d.text.contains("+hello"));
        assert!(g.show(&hash[..7]).is_ok());
        assert!(g.show("--all").is_err());
    }

    #[test]
    fn git_commit_and_failing_hook() {
        let g = repo("commit");
        write(&g, "a.txt", "hi\n");
        g.stage(&["a.txt".into()]).unwrap();
        g.commit("Subject line\n\nBody text\n").unwrap();
        assert_eq!(
            sh(&g.root, &["log", "-1", "--format=%B"]),
            "Subject line\n\nBody text"
        );

        let hooks = g.root.join(".git").join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\necho 'lint: trailing whitespace in a.txt' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        write(&g, "a.txt", "changed\n");
        g.stage(&["a.txt".into()]).unwrap();
        let err = g.commit("second").unwrap_err();
        assert!(err.contains("lint: trailing whitespace in a.txt"), "{err}");
        assert_eq!(paths(&g.status().unwrap().staged), ["a.txt"]);
    }

    #[test]
    fn git_undo_leaves_the_changes_staged() {
        let g = repo("undo");
        let first = commit_file(&g, "a.txt", "1\n", "first");
        let second = commit_file(&g, "b.txt", "2\n", "second\n\nwith body");
        assert_eq!(g.undo_commit(&second).unwrap(), "second\n\nwith body");
        assert_eq!(sh(&g.root, &["rev-parse", "HEAD"]), first);
        let s = g.status().unwrap();
        assert_eq!(s.staged, [entry("b.txt", None, 'A')]);
        assert!(s.unstaged.is_empty() && s.untracked.is_empty());
    }

    #[test]
    fn git_undo_refusals() {
        let g = repo("refuse");
        assert!(g.undo_commit("abcd").is_err());
        let first = commit_file(&g, "a.txt", "1\n", "first");
        let err = g.undo_commit(&first).unwrap_err();
        assert!(err.contains("first commit"), "{err}");

        let second = commit_file(&g, "a.txt", "2\n", "second");
        let err = g.undo_commit(&first).unwrap_err();
        assert!(err.contains("HEAD has moved"), "{err}");

        assert_eq!(sh(&g.root, &["rev-parse", "HEAD"]), second);
    }

    #[test]
    fn git_undo_allowed_when_pushed() {
        let g = repo("pushed");
        let first = commit_file(&g, "a.txt", "1\n", "first");
        let second = commit_file(&g, "a.txt", "2\n", "second");
        with_bare_remote(&g);
        sh(&g.root, &["push", "-q", "origin", "main"]);
        assert_eq!(g.undo_commit(&second).unwrap(), "second");
        assert_eq!(sh(&g.root, &["rev-parse", "HEAD"]), first);
    }

    #[test]
    fn git_undo_refused_mid_merge() {
        let g = repo("merge");
        commit_file(&g, "a.txt", "base\n", "base");
        sh(&g.root, &["switch", "-q", "-c", "other"]);
        commit_file(&g, "a.txt", "other\n", "other side");
        sh(&g.root, &["switch", "-q", "main"]);
        let head = commit_file(&g, "a.txt", "main\n", "main side");
        let out = Command::new(exe())
            .arg("-C")
            .arg(&g.root)
            .args(["merge", "other"])
            .output()
            .unwrap();
        assert!(!out.status.success(), "the merge should conflict");
        assert_eq!(g.status().unwrap().conflicted, [entry("a.txt", None, 'U')]);
        let err = g.undo_commit(&head).unwrap_err();
        assert!(err.contains("merge is in progress"), "{err}");
        assert_eq!(sh(&g.root, &["rev-parse", "HEAD"]), head);
    }
}
