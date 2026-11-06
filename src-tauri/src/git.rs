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
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::State;

use crate::{profiles, settings::SettingsState};

const DIFF_CAP: usize = 1024 * 1024;
const BACKGROUND_FETCH_TIMEOUT: Duration = Duration::from_secs(60);
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
    pub(crate) branch: Option<String>,
    oid: Option<String>,
    pub(crate) upstream: Option<String>,
    pub(crate) ahead: u32,
    pub(crate) behind: u32,
    pub(crate) staged: Vec<GitFileEntry>,
    pub(crate) unstaged: Vec<GitFileEntry>,
    pub(crate) untracked: Vec<GitFileEntry>,
    pub(crate) conflicted: Vec<GitFileEntry>,
    remotes: Vec<String>,
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
pub(crate) fn parse_status(bytes: &[u8]) -> GitStatus {
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

pub(crate) struct Output {
    pub(crate) ok: bool,
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    truncated: bool,
}

impl Output {
    pub(crate) fn stdout(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }

    /// Git's combined stdout and stderr, trimmed, for showing a failure as is.
    pub(crate) fn message(&self) -> String {
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

/// The remote a branch with no upstream is published to: `origin`, else the only remote.
pub(crate) fn publish_remote(remotes: &[String]) -> Option<&str> {
    match remotes {
        [only] => Some(only),
        _ => remotes.iter().find(|r| *r == "origin").map(String::as_str),
    }
}

/// Runs `cmd` to completion, killing it once `timeout` passes. `stdin`, when given, is fed to
/// the child; otherwise the caller's stdin setting stands.
fn run_with_deadline(
    mut cmd: Command,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output, String> {
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
    if let Some(bytes) = stdin {
        let mut pipe = child.stdin.take().expect("stdin is piped");
        let bytes = bytes.to_vec();
        thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    fn drain(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    }
    let out_reader = drain(child.stdout.take().expect("stdout is piped"));
    let err_reader = drain(child.stderr.take().expect("stderr is piped"));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        let now = Instant::now();
        if now >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // The reader threads are left to finish on their own: a killed git.exe can leave
            // git-remote-https or ssh holding the pipes open, and joining would hang.
            return Err(format!(
                "git timed out after {} seconds",
                timeout.as_secs_f64()
            ));
        }
        thread::sleep((deadline - now).min(Duration::from_millis(100)));
    };
    Ok(Output {
        ok: status.success(),
        code: status.code(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
        truncated: false,
    })
}

pub(crate) struct Git {
    exe: PathBuf,
    root: PathBuf,
}

impl Git {
    pub(crate) fn open(settings: &SettingsState, root: &str) -> Result<Self, String> {
        let root = check_root(root)?;
        Ok(Self {
            exe: locate_git(settings)?,
            root,
        })
    }

    /// The same git executable run in another folder.
    pub(crate) fn at(&self, root: PathBuf) -> Self {
        Self {
            exe: self.exe.clone(),
            root,
        }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
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

    pub(crate) fn read<I, S>(&self, args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.exec(self.command(true, args), None, None)
    }

    pub(crate) fn write<I, S>(&self, args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.exec(self.command(false, args), None, None)
    }

    /// A read that feeds `stdin` to git, adds `envs`, and drops `removed` from the inherited
    /// environment, for `git credential fill`. Killed once `timeout` passes.
    pub(crate) fn read_input<I, S>(
        &self,
        args: I,
        stdin: &[u8],
        envs: &[(&str, &str)],
        removed: &[&str],
        timeout: Duration,
    ) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = self.command(true, args);
        for name in removed {
            cmd.env_remove(name);
        }
        cmd.envs(envs.iter().copied());
        run_with_deadline(cmd, Some(stdin), timeout)
    }

    /// Succeeds only when git does, giving its trimmed stdout.
    pub(crate) fn ok(out: Output) -> Result<String, String> {
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
        let mut status = parse_status(&out.stdout);
        status.remotes = Self::ok(self.read(["remote"])?)?
            .lines()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(str::to_string)
            .collect();
        Ok(status)
    }

    /// The repo's common git dir, which every worktree of the repo shares.
    pub(crate) fn common_dir(&self) -> Result<PathBuf, String> {
        let dir = Self::ok(self.read(["rev-parse", "--git-common-dir"])?)?;
        Ok(self.root.join(dir))
    }

    /// A command that talks to a remote. A background one must never wait on a credential
    /// prompt; a manual one may still open Git Credential Manager's own window.
    fn remote_command(&self, background: bool, args: &[&str]) -> Command {
        let mut cmd = self.command(false, args);
        if background {
            cmd.env("GCM_INTERACTIVE", "never");
        }
        cmd
    }

    pub(crate) fn fetch(&self, background: bool) -> Result<(), String> {
        let mut cmd = self.remote_command(background, &["fetch", "--prune"]);
        let out = if background {
            cmd.stdin(Stdio::null());
            run_with_deadline(cmd, None, BACKGROUND_FETCH_TIMEOUT)?
        } else {
            self.exec(cmd, None, None)?
        };
        Self::ok(out).map(|_| ())
    }

    pub(crate) fn pull(&self) -> Result<(), String> {
        let cmd = self.remote_command(false, &["pull", "--ff-only"]);
        Self::ok(self.exec(cmd, None, None)?).map(|_| ())
    }

    /// Pushes the branch, or publishes it when it has no upstream. Never forces.
    pub(crate) fn push(&self) -> Result<(), String> {
        let status = self.status()?;
        let Some(branch) = status.branch.as_deref() else {
            return Err("HEAD is detached".into());
        };
        let cmd = if status.upstream.is_some() {
            self.remote_command(false, &["push"])
        } else {
            let remote = match publish_remote(&status.remotes) {
                Some(r) => r,
                None if status.remotes.is_empty() => {
                    return Err("This repo has no remote".into());
                }
                None => {
                    return Err(
                        "Several remotes and none named origin; publish from a terminal".into(),
                    );
                }
            };
            self.remote_command(false, &["push", "-u", remote, branch])
        };
        Self::ok(self.exec(cmd, None, None)?).map(|_| ())
    }

    /// Pushes `hash` and its ancestors to the branch's upstream, leaving newer commits local.
    /// Never forces, so git rejects it when the upstream is not an ancestor of `hash`.
    pub(crate) fn push_up_to(&self, hash: &str) -> Result<(), String> {
        if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("Not a commit hash: {hash}"));
        }
        let status = self.status()?;
        let Some(branch) = status.branch.as_deref() else {
            return Err("HEAD is detached".into());
        };
        if status.upstream.is_none() {
            return Err("The branch has no upstream; publish it first".into());
        }
        if !self.read(["merge-base", "--is-ancestor", hash, "HEAD"])?.ok {
            return Err("That commit is not on the current branch".into());
        }
        let config = |key: &str| -> Result<String, String> {
            Ok(Self::ok(self.read(["config", "--get", &format!("branch.{branch}.{key}")])?)?
                .trim()
                .to_string())
        };
        let remote = config("remote")?;
        let merge = config("merge")?;
        // "." means the upstream is another local branch, which is not a remote to push to.
        if remote == "." {
            return Err("The upstream is a local branch".into());
        }
        let refspec = format!("{hash}:{merge}");
        let cmd = self.remote_command(false, &["push", &remote, &refspec]);
        Self::ok(self.exec(cmd, None, None)?).map(|_| ())
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
pub(crate) async fn run<T, F>(
    settings: State<'_, SettingsState>,
    root: String,
    work: F,
) -> Result<T, String>
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
pub(crate) mod test_support {
    use super::*;
    use std::{
        cell::RefCell,
        fs,
        ops::Deref,
        sync::atomic::{AtomicU32, Ordering},
    };

    pub(crate) fn exe() -> PathBuf {
        on_path().expect("git on PATH for tests")
    }

    /// A fresh folder under the system temp dir; never inside an existing repo's tree.
    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("bashboard-git-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // CI runners' temp dir is an 8.3 short path (RUNNER~1), while git reports long paths, so
        // tests comparing the two would fail. Expand it, dropping canonicalize's \\?\ prefix.
        let long = fs::canonicalize(&dir).unwrap();
        let long = long.to_string_lossy();
        PathBuf::from(long.strip_prefix(r"\\?\").unwrap_or(&long))
    }

    /// Runs git for test setup, panicking on failure.
    pub(crate) fn sh(dir: &Path, args: &[&str]) -> String {
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
    pub(crate) struct Repo {
        pub(crate) git: Git,
        pub(crate) remotes: RefCell<Vec<PathBuf>>,
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

    /// Appends to `.git/config` directly: git spawns are what make these tests slow on Windows,
    /// and a repeated `[core]` section is valid config.
    pub(crate) fn configure(dir: &Path) {
        use std::io::Write;
        let mut config = fs::OpenOptions::new()
            .append(true)
            .open(dir.join(".git").join("config"))
            .unwrap();
        config
            .write_all(
                b"[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n\
                  [core]\n\thooksPath = .git/hooks\n\tautocrlf = false\n",
            )
            .unwrap();
    }

    pub(crate) fn repo(tag: &str) -> Repo {
        let root = temp_dir(tag);
        sh(&root, &["init", "-q", "-b", "main"]);
        configure(&root);
        Repo {
            git: Git { exe: exe(), root },
            remotes: RefCell::new(Vec::new()),
        }
    }

    pub(crate) fn write(g: &Git, name: &str, text: &str) {
        fs::write(g.root.join(name), text).unwrap();
    }

    pub(crate) fn commit_file(g: &Git, name: &str, text: &str, msg: &str) -> String {
        write(g, name, text);
        sh(&g.root, &["add", "--", name]);
        sh(&g.root, &["commit", "-q", "-m", msg]);
        sh(&g.root, &["rev-parse", "HEAD"])
    }

    pub(crate) fn with_bare_remote(g: &Repo) {
        let bare = temp_dir("bare");
        sh(&bare, &["init", "-q", "--bare"]);
        sh(
            &g.root,
            &["remote", "add", "origin", &bare.to_string_lossy()],
        );
        g.remotes.borrow_mut().push(bare);
    }

    /// A second clone of the repo's first bare remote, removed with the repo.
    pub(crate) fn clone_of(g: &Repo) -> PathBuf {
        let bare = g.remotes.borrow()[0].clone();
        let dir = temp_dir("clone");
        sh(
            &dir,
            &["clone", "-q", "-b", "main", &bare.to_string_lossy(), "."],
        );
        configure(&dir);
        g.remotes.borrow_mut().push(dir.clone());
        dir
    }

    pub(crate) fn commit_in(dir: &Path, name: &str, text: &str, msg: &str) -> String {
        fs::write(dir.join(name), text).unwrap();
        sh(dir, &["add", "--", name]);
        sh(dir, &["commit", "-q", "-m", msg]);
        sh(dir, &["rev-parse", "HEAD"])
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::fs;

    fn paths(entries: &[GitFileEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.path.as_str()).collect()
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

    #[test]
    fn git_publish_remote_choice() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(publish_remote(&names(&[])), None);
        assert_eq!(publish_remote(&names(&["origin", "fork"])), Some("origin"));
        assert_eq!(publish_remote(&names(&["fork", "origin"])), Some("origin"));
        assert_eq!(publish_remote(&names(&["fork"])), Some("fork"));
        assert_eq!(publish_remote(&names(&["a", "b"])), None);
    }

    #[test]
    fn git_common_dir_is_the_git_folder() {
        let g = repo("common");
        let dir = g.common_dir().unwrap();
        assert!(dir.is_absolute(), "{dir:?}");
        assert!(dir.join("HEAD").is_file(), "{dir:?}");
    }

    #[test]
    fn git_pull_fast_forwards_and_refuses_diverged() {
        let g = repo("pull");
        with_bare_remote(&g);
        commit_file(&g, "a.txt", "1\n", "first");
        sh(&g.root, &["push", "-q", "-u", "origin", "main"]);
        let clone = clone_of(&g);
        let theirs = commit_in(&clone, "a.txt", "2\n", "from the clone");
        sh(&clone, &["push", "-q", "origin", "main"]);

        g.pull().unwrap();
        assert_eq!(sh(&g.root, &["rev-parse", "HEAD"]), theirs);

        let ours = commit_file(&g, "b.txt", "local\n", "local");
        commit_in(&clone, "c.txt", "remote\n", "remote");
        sh(&clone, &["push", "-q", "origin", "main"]);
        let err = g.pull().unwrap_err();
        assert!(err.to_lowercase().contains("fast-forward"), "{err}");
        assert_eq!(sh(&g.root, &["rev-parse", "HEAD"]), ours);
    }

    #[test]
    fn git_push_and_publish() {
        let g = repo("push");
        with_bare_remote(&g);
        commit_file(&g, "a.txt", "1\n", "first");
        assert_eq!(g.status().unwrap().upstream, None);
        g.push().unwrap();
        let s = g.status().unwrap();
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.ahead, 0);

        commit_file(&g, "a.txt", "2\n", "second");
        assert_eq!(g.status().unwrap().ahead, 1);
        g.push().unwrap();
        assert_eq!(g.status().unwrap().ahead, 0);

        let clone = clone_of(&g);
        commit_in(&clone, "b.txt", "theirs\n", "theirs");
        sh(&clone, &["push", "-q", "origin", "main"]);
        let ours = commit_file(&g, "c.txt", "ours\n", "ours");
        let err = g.push().unwrap_err();
        assert!(err.contains("rejected"), "{err}");
        assert_eq!(sh(&g.root, &["rev-parse", "HEAD"]), ours);
    }

    #[test]
    fn git_push_up_to() {
        let g = repo("push-up-to");
        with_bare_remote(&g);
        commit_file(&g, "a.txt", "1
", "first");
        g.push().unwrap();
        let second = commit_file(&g, "a.txt", "2
", "second");
        commit_file(&g, "a.txt", "3
", "third");
        assert_eq!(g.status().unwrap().ahead, 2);

        g.push_up_to(&second).unwrap();
        assert_eq!(g.status().unwrap().ahead, 1);
        assert_eq!(sh(&g.root, &["rev-parse", "origin/main"]), second);

        let err = g.push_up_to("not-a-hash").unwrap_err();
        assert!(err.contains("Not a commit hash"), "{err}");

        sh(&g.root, &["switch", "-q", "-c", "other", &second]);
        let elsewhere = commit_file(&g, "b.txt", "x
", "elsewhere");
        sh(&g.root, &["switch", "-q", "main"]);
        let err = g.push_up_to(&elsewhere).unwrap_err();
        assert!(err.contains("not on the current branch"), "{err}");

        let g = repo("push-up-to-unpublished");
        with_bare_remote(&g);
        let only = commit_file(&g, "a.txt", "1
", "first");
        let err = g.push_up_to(&only).unwrap_err();
        assert!(err.contains("no upstream"), "{err}");
    }

    #[test]
    fn git_push_refusals() {
        let g = repo("push-detached");
        with_bare_remote(&g);
        commit_file(&g, "a.txt", "1\n", "first");
        sh(&g.root, &["switch", "-q", "--detach"]);
        let err = g.push().unwrap_err();
        assert!(err.contains("detached"), "{err}");

        let g = repo("push-none");
        commit_file(&g, "a.txt", "1\n", "first");
        let err = g.push().unwrap_err();
        assert!(err.contains("no remote"), "{err}");

        let g = repo("push-two");
        commit_file(&g, "a.txt", "1\n", "first");
        sh(&g.root, &["remote", "add", "a", "../a.git"]);
        sh(&g.root, &["remote", "add", "b", "../b.git"]);
        let err = g.push().unwrap_err();
        assert!(err.contains("none named origin"), "{err}");
    }

    #[test]
    fn git_remote_environment() {
        let g = repo("env");
        let env = |background: bool| {
            g.remote_command(background, &["fetch"])
                .get_envs()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.map(|v| v.to_string_lossy().into_owned()),
                    )
                })
                .collect::<Vec<_>>()
        };
        let pair = |k: &str, v: &str| (k.to_string(), Some(v.to_string()));
        let bg = env(true);
        assert!(bg.contains(&pair("GIT_TERMINAL_PROMPT", "0")), "{bg:?}");
        assert!(bg.contains(&pair("GCM_INTERACTIVE", "never")), "{bg:?}");
        let manual = env(false);
        assert!(
            manual.contains(&pair("GIT_TERMINAL_PROMPT", "0")),
            "{manual:?}"
        );
        assert!(
            !manual.iter().any(|(k, _)| k == "GCM_INTERACTIVE"),
            "{manual:?}"
        );
    }

    #[test]
    fn git_run_with_deadline_kills_a_hung_git() {
        let g = repo("hung");
        let mut cmd = g.command(true, ["cat-file", "--batch"]);
        cmd.stdin(Stdio::piped());
        let start = Instant::now();
        let Err(err) = run_with_deadline(cmd, None, Duration::from_millis(300)) else {
            panic!("a hung git should time out");
        };
        assert!(err.contains("timed out"), "{err}");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{:?}",
            start.elapsed()
        );
    }
}
