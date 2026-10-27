use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::hooks::Hooks;
use crate::profiles;
use crate::settings::{self, SettingsState};

/// Per-session markers Claude Code sets in its own environment. User configuration such as
/// CLAUDE_CODE_USE_* or ANTHROPIC_* is deliberately left alone.
const INHERITED_SESSION_VARS: &[&str] = &[
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

/// Point the shipped hook script at the receiver (design section 3.3).
const HOOK_URL_VAR: &str = "BASHBOARD_HOOK_URL";
const HOOK_TOKEN_VAR: &str = "BASHBOARD_HOOK_TOKEN";

/// What to run in a new pty.
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Extra variables set after the built-in ones.
    pub env: Vec<(String, String)>,
}

/// The hook variables for a new shell; empty when the receiver is not running.
fn hook_env(url: Option<&str>, token: Option<&str>) -> Vec<(String, String)> {
    match (url, token) {
        (Some(url), Some(token)) => {
            vec![(HOOK_URL_VAR.into(), url.into()), (HOOK_TOKEN_VAR.into(), token.into())]
        }
        _ => Vec::new(),
    }
}

/// `dir` followed by the inherited `PATH`; `dir` alone when there is none. Leaves the value
/// unchanged when `dir` is already the first entry, so a Bashboard launched from another
/// Bashboard's pane does not stack copies.
fn path_with(dir: &Path, inherited: Option<&OsStr>) -> OsString {
    let inherited = inherited.filter(|v| !v.is_empty());
    let Some(inherited) = inherited else { return dir.as_os_str().to_owned() };
    let dir_text = dir.to_string_lossy();
    let inherited_text = inherited.to_string_lossy();
    let first = inherited_text.split(';').next().unwrap_or("");
    if first.eq_ignore_ascii_case(&dir_text) {
        return inherited.to_owned();
    }
    let mut out = dir.as_os_str().to_owned();
    out.push(";");
    out.push(inherited);
    out
}

/// The `PATH` for a new shell: the folder holding this exe (where `bb.exe` sits) first.
fn path_env() -> Vec<(String, String)> {
    let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) else {
        return Vec::new();
    };
    match path_with(&dir, std::env::var_os("PATH").as_deref()).into_string() {
        Ok(path) => vec![("PATH".into(), path)],
        Err(_) => {
            eprintln!("pty: PATH is not valid Unicode, so bb will not be on the shell's PATH");
            Vec::new()
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: u32,
    pub pid: u32,
    pub started_at: u64,
}

struct Pane {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: u32,
    started_at: u64,
}

#[derive(Default)]
struct Inner {
    panes: Mutex<HashMap<u32, Pane>>,
    next_id: AtomicU32,
}

/// Live ptys keyed by id, so one window can host many panes. Ids are assigned here and never
/// reused, because a page reload restarts the front end while older ptys may still be exiting.
#[derive(Clone, Default)]
pub struct Ptys {
    inner: Arc<Inner>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn build_command(spec: &SpawnSpec, id: u32) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "bashboard");
    cmd.env("BASHBOARD_PANE_ID", id.to_string());
    // Keeps a login shell's profile from changing to the home directory, so the cwd sticks.
    cmd.env("CHERE_INVOKING", "1");
    // If this app was itself launched from a Claude Code session, `claude` run in its panes would
    // see these markers, treat itself as that session's child, and stop saving transcripts.
    for var in INHERITED_SESSION_VARS {
        cmd.env_remove(var);
    }
    // A Bashboard launched from another Bashboard's pane must not post to that one's receiver.
    cmd.env_remove(HOOK_URL_VAR);
    cmd.env_remove(HOOK_TOKEN_VAR);
    // Git Bash's login profile rebuilds PATH from ORIGINAL_PATH when it is set, which it is when
    // this app was launched from a Git Bash; the inherited copy would drop the PATH set below.
    cmd.env_remove("ORIGINAL_PATH");
    for (key, value) in &spec.env {
        cmd.env(key, value);
    }
    match spec.cwd.as_ref().filter(|p| p.is_dir()) {
        Some(dir) => cmd.cwd(dir),
        None => {
            if let Some(home) = std::env::var_os("USERPROFILE") {
                cmd.cwd(home);
            }
        }
    }
    cmd
}

impl Ptys {
    /// Starts `spec` in a new pty and returns its id. `on_data` receives output until it returns
    /// false or the pty closes; `on_exit` receives the exit code once the child has exited and
    /// the pane has been removed.
    pub fn spawn(
        &self,
        spec: SpawnSpec,
        cols: u16,
        rows: u16,
        mut on_data: impl FnMut(&[u8]) -> bool + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<u32, String> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;

        let mut child = pair.slave.spawn_command(build_command(&spec, id)).map_err(|e| e.to_string())?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let pid = child.process_id().unwrap_or(0);
        // Registered before the exit watcher starts, so a shell that dies at once is still removed.
        self.inner.panes.lock().unwrap().insert(
            id,
            Pane { master: pair.master, writer, killer, pid, started_at: now_ms() },
        );

        thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if !on_data(&buf[..n]) {
                            break;
                        }
                    }
                }
            }
        });

        // ConPTY keeps the reader blocked after the shell exits until the master is dropped,
        // so exit is detected by waiting on the child, which then releases the master.
        let inner = Arc::clone(&self.inner);
        thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            let pane = inner.panes.lock().unwrap().remove(&id);
            // Closing the pseudoconsole can block until output drains, so not under the lock.
            drop(pane);
            on_exit(code);
        });

        Ok(id)
    }

    pub fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        let mut panes = self.inner.panes.lock().unwrap();
        let pane = panes.get_mut(&id).ok_or("no such pty")?;
        pane.writer.write_all(data).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let panes = self.inner.panes.lock().unwrap();
        let pane = panes.get(&id).ok_or("no such pty")?;
        pane.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) -> Result<(), String> {
        let mut panes = self.inner.panes.lock().unwrap();
        let pane = panes.get_mut(&id).ok_or("no such pty")?;
        // portable-pty's Windows killer reports an error when TerminateProcess succeeds, so the
        // result is meaningless; the exit waiter is what confirms the child is gone.
        let _ = pane.killer.kill();
        Ok(())
    }

    pub fn contains(&self, id: u32) -> bool {
        self.inner.panes.lock().unwrap().contains_key(&id)
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        let panes = self.inner.panes.lock().unwrap();
        let mut list: Vec<PtyInfo> = panes
            .iter()
            .map(|(&id, p)| PtyInfo { id, pid: p.pid, started_at: p.started_at })
            .collect();
        list.sort_by_key(|p| p.id);
        list
    }
}

/// How often the activity sweep samples the process table.
const ACTIVITY_SWEEP: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PtyActivity {
    pub id: u32,
    pub busy: bool,
}

pub struct ProcEntry {
    pub parent: Option<u32>,
    pub name: String,
}

pub type ProcNames = HashMap<u32, ProcEntry>;

fn is_bash(name: &str) -> bool {
    name.eq_ignore_ascii_case("bash.exe")
}

/// Whether the shell under `pty_pid` is running a foreground job. Git's launcher bash.exe
/// spawns the real usr\bin\bash.exe as its only child, so the launcher always "has a child";
/// descend through such bash-only chains and judge the deepest shell. A missing process is idle.
pub fn shell_busy(pty_pid: u32, procs: &ProcNames) -> bool {
    if !procs.contains_key(&pty_pid) {
        return false;
    }
    let children_of = |pid: u32| -> Vec<u32> {
        procs.iter().filter(|(_, p)| p.parent == Some(pid)).map(|(&c, _)| c).collect()
    };
    let mut current = pty_pid;
    // A visited set guards against pid reuse forming a parent cycle.
    let mut seen = HashSet::from([current]);
    loop {
        let kids = children_of(current);
        match kids.as_slice() {
            [only] if is_bash(&procs[only].name) && seen.insert(*only) => current = *only,
            _ => return !kids.is_empty(),
        }
    }
}

fn proc_names(sys: &mut System) -> ProcNames {
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes()
        .iter()
        .map(|(pid, p)| {
            (
                pid.as_u32(),
                ProcEntry {
                    parent: p.parent().map(|pp| pp.as_u32()),
                    name: p.name().to_string_lossy().into_owned(),
                },
            )
        })
        .collect()
}

/// The console host process serving `pid`'s console, which every process in one ConPTY shares.
#[cfg(windows)]
fn console_host(pid: u32) -> Option<usize> {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_CONSOLE_HOST_PROCESS: u32 = 49;
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryInformationProcess(h: isize, class: u32, out: *mut usize, len: u32, ret: *mut u32) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(h: isize) -> i32;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return None;
        }
        let (mut host, mut len) = (0usize, 0u32);
        let status = NtQueryInformationProcess(handle, PROCESS_CONSOLE_HOST_PROCESS, &mut host, size_of::<usize>() as u32, &mut len);
        CloseHandle(handle);
        (status >= 0 && host != 0).then_some(host)
    }
}

#[cfg(not(windows))]
fn console_host(_pid: u32) -> Option<usize> {
    None
}

/// Whether an orphan counts as a running job. A nested interactive shell is itself an orphan,
/// so it is judged by its own children rather than by existing.
fn orphan_busy(pid: u32, procs: &ProcNames) -> bool {
    procs.get(&pid).is_some_and(|p| !is_bash(&p.name) || shell_busy(pid, procs))
}

struct Orphan {
    start: u64,
    host: usize,
    busy: bool,
}

/// Process table plus console hosts already looked up, keyed by (pid, start time) so a reused
/// pid is looked up afresh.
#[derive(Default)]
pub struct ActivityProbe {
    sys: System,
    hosts: HashMap<(u32, u64), Option<usize>>,
}

impl ActivityProbe {
    /// MSYS exec leaves a foreground job such as `sleep` parented to a short-lived fork stub that
    /// has already exited, so the job is missing from the shell's subtree, and its Windows
    /// environment is trimmed so it cannot be tagged by variable either. Such an orphan still
    /// shares its pane's console host.
    fn orphans(&mut self, procs: &ProcNames, since: u64) -> Vec<Orphan> {
        let mut live = HashSet::new();
        let mut out = Vec::new();
        for (pid, p) in self.sys.processes() {
            let (pid, start) = (pid.as_u32(), p.start_time());
            if start < since || p.parent().is_some_and(|pp| procs.contains_key(&pp.as_u32())) {
                continue;
            }
            live.insert((pid, start));
            let host = *self.hosts.entry((pid, start)).or_insert_with(|| console_host(pid));
            if let Some(host) = host {
                out.push(Orphan { start, host, busy: orphan_busy(pid, procs) });
            }
        }
        self.hosts.retain(|k, _| live.contains(k));
        out
    }
}

impl Ptys {
    /// One activity verdict per live pty, in id order.
    pub fn activity(&self, probe: &mut ActivityProbe) -> Vec<PtyActivity> {
        let list = self.list();
        if list.is_empty() {
            return Vec::new();
        }
        let procs = proc_names(&mut probe.sys);
        let since = list.iter().map(|p| p.started_at / 1000).min().unwrap_or(0);
        let orphans = probe.orphans(&procs, since);
        list.into_iter()
            .map(|p| {
                let busy = shell_busy(p.pid, &procs)
                    || (procs.contains_key(&p.pid)
                        && console_host(p.pid).is_some_and(|host| {
                            orphans.iter().any(|o| o.busy && o.host == host && o.start >= p.started_at / 1000)
                        }));
                PtyActivity { id: p.id, busy }
            })
            .collect()
    }
}

/// Sweeps every 2 seconds and emits `pty://activity` whenever the verdicts differ from the
/// last emission.
pub fn init_activity(app: &AppHandle) {
    let ptys = app.state::<Ptys>().inner().clone();
    let app = app.clone();
    thread::spawn(move || {
        let mut probe = ActivityProbe::default();
        let mut last: Option<Vec<PtyActivity>> = None;
        loop {
            thread::sleep(ACTIVITY_SWEEP);
            let list = ptys.activity(&mut probe);
            if last.as_ref() != Some(&list) {
                let _ = app.emit("pty://activity", &list);
                last = Some(list);
            }
        }
    });
}

/// First existing directory among the requested cwd, the configured starting directory, and the
/// user profile.
fn resolve_cwd(requested: Option<String>, starting_directory: &str) -> Option<PathBuf> {
    let candidates = [
        requested.map(PathBuf::from),
        Some(starting_directory).filter(|s| !s.is_empty()).map(|s| PathBuf::from(settings::expand_env(s))),
        std::env::var_os("USERPROFILE").map(PathBuf::from),
    ];
    candidates.into_iter().flatten().find(|p| p.is_dir())
}

/// cmd has no hook that runs before each prompt, so its prompt itself reports the working
/// directory (OSC 9;9), kept in front of the user's own PROMPT.
fn cmd_prompt(inherited: Option<&str>) -> String {
    let rest = inherited.filter(|s| !s.is_empty()).unwrap_or("$P$G");
    format!("$e]9;9;$P$e\\{rest}")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
    pub id: u32,
    /// The profile id actually started, after fallbacks.
    pub profile: String,
    /// The profile that was asked for, when it is not installed and `profile` replaced it.
    pub fallback_from: Option<String>,
}

/// A non-empty `command` runs in place of the resolved profile's program and arguments; an empty
/// one is an error.
fn spawn_spec(
    command: Option<Vec<String>>,
    resolved: &profiles::ShellProfile,
    env: Vec<(String, String)>,
    cwd: Option<PathBuf>,
) -> Result<SpawnSpec, String> {
    let mut env = env;
    let (program, args) = match command {
        Some(mut command) => {
            if command.is_empty() {
                return Err("command must not be empty".into());
            }
            let program = command.remove(0);
            (program, command)
        }
        None => {
            if resolved.id == profiles::CMD {
                env.push(("PROMPT".into(), cmd_prompt(std::env::var("PROMPT").ok().as_deref())));
            }
            (resolved.path.clone(), resolved.args.clone())
        }
    };
    Ok(SpawnSpec { program, args, cwd, env })
}

#[tauri::command]
pub fn pty_spawn(
    state: State<'_, Ptys>,
    settings: State<'_, SettingsState>,
    hooks: State<'_, Hooks>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    profile: Option<String>,
    command: Option<Vec<String>>,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<u32>,
) -> Result<Spawned, String> {
    let shell = settings.current().shell;
    // A command was never asked to be a shell profile, so it reports the default and no fallback.
    let requested = if command.is_some() { None } else { profile.as_deref() };
    let resolved = profiles::resolve(requested, &shell);
    let fallback_from = profiles::fallback_from(requested, &shell.default_profile, &resolved.id);
    let mut env = hook_env(hooks.url(), hooks.token());
    env.extend(path_env());
    let spec = spawn_spec(command, &resolved, env, resolve_cwd(cwd, &shell.starting_directory))?;
    let id = state.spawn(
        spec,
        cols,
        rows,
        move |bytes| on_data.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok(),
        move |code| {
            let _ = on_exit.send(code);
        },
    )?;
    Ok(Spawned { id, profile: resolved.id, fallback_from })
}

#[tauri::command]
pub fn pty_write(state: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    log_input(&data);
    state.write(id, data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Ptys>, id: u32) -> Result<(), String> {
    state.kill(id)
}

#[tauri::command]
pub fn pty_list(state: State<'_, Ptys>) -> Vec<PtyInfo> {
    state.list()
}

/// Appends every keystroke sent to a pty, escaped, to the file named by BASHBOARD_KEYLOG.
/// Used to verify which key combinations actually reach the shell.
fn log_input(data: &str) {
    let Ok(path) = std::env::var("BASHBOARD_KEYLOG") else { return };
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", data.escape_debug());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const TIMEOUT: Duration = Duration::from_secs(10);
    const DEFAULT_SHELL: &str = crate::settings::DEFAULT_GIT_BASH_PATH;

    fn shell() -> Option<String> {
        let path = std::env::var("BASHBOARD_SHELL").unwrap_or_else(|_| DEFAULT_SHELL.into());
        if PathBuf::from(&path).is_file() {
            Some(path)
        } else {
            println!("skipping: no shell at {path}");
            None
        }
    }

    fn spec(program: &str, args: &[&str], cwd: Option<PathBuf>) -> SpawnSpec {
        SpawnSpec {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd,
            env: Vec::new(),
        }
    }

    /// Drops CSI and OSC escape sequences, which ConPTY interleaves with program output.
    fn strip_ansi(s: &str) -> String {
        let mut out = String::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\x1b' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' {
                            break;
                        }
                        if c == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
        out
    }

    struct Run {
        id: u32,
        output: Arc<Mutex<Vec<u8>>>,
        exit: mpsc::Receiver<u32>,
    }

    impl Run {
        fn text(&self) -> String {
            strip_ansi(&String::from_utf8_lossy(&self.output.lock().unwrap()))
        }

        fn wait_exit(&self) -> u32 {
            match self.exit.recv_timeout(TIMEOUT) {
                Ok(code) => code,
                Err(_) => panic!("pty did not exit in time; output so far: {:?}", self.text()),
            }
        }

        /// The reader may still be draining after exit fires, so poll for the expected text.
        fn wait_for(&self, needle: &str) -> String {
            let deadline = Instant::now() + TIMEOUT;
            loop {
                let text = self.text();
                if text.contains(needle) || Instant::now() > deadline {
                    return text;
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }

    fn start(ptys: &Ptys, spec: SpawnSpec) -> Run {
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&output);
        let (tx, exit) = mpsc::channel();
        let (dsr_tx, dsr_rx) = mpsc::channel::<()>();
        let id = ptys
            .spawn(
                spec,
                200,
                24,
                move |b| {
                    if b.windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = dsr_tx.send(());
                    }
                    sink.lock().unwrap().extend_from_slice(b);
                    true
                },
                move |code| {
                    let _ = tx.send(code);
                },
            )
            .expect("spawn failed");
        // portable-pty opens ConPTY with PSEUDOCONSOLE_INHERIT_CURSOR, so ConPTY asks for the
        // cursor position and starts the child only once answered; xterm.js does this in the app.
        let responder = ptys.clone();
        thread::spawn(move || {
            while dsr_rx.recv().is_ok() {
                let _ = responder.write(id, b"\x1b[1;1R");
            }
        });
        Run { id, output, exit }
    }

    #[test]
    fn echo_runs_and_exits_cleanly() {
        let Some(sh) = shell() else { return };
        let ptys = Ptys::default();
        let run = start(&ptys, spec(&sh, &["-c", "echo hi"], None));
        assert_eq!(run.wait_exit(), 0);
        let text = run.wait_for("hi");
        assert!(text.contains("hi"), "output was {text:?}");
        assert!(ptys.list().iter().all(|p| p.id != run.id));
    }

    #[test]
    fn sets_terminal_env() {
        let Some(sh) = shell() else { return };
        let ptys = Ptys::default();
        let script = r#"echo "$TERM_PROGRAM:$BASHBOARD_PANE_ID:$BASHBOARD_HOOK_URL:$BASHBOARD_HOOK_TOKEN""#;
        let mut with_hooks = spec(&sh, &["-c", script], None);
        with_hooks.env = hook_env(Some("http://127.0.0.1:5"), Some("tok"));
        let run = start(&ptys, with_hooks);
        assert_eq!(run.wait_exit(), 0);
        let expected = format!("bashboard:{}:http://127.0.0.1:5:tok", run.id);
        let text = run.wait_for(&expected);
        assert!(text.contains(&expected), "output was {text:?}");
    }

    #[test]
    fn hook_env_only_when_receiver_runs() {
        let get = |cmd: &CommandBuilder, var| cmd.get_env(var).and_then(|v| v.to_str()).map(str::to_owned);
        let mut with = spec("bash", &[], None);
        with.env = hook_env(Some("http://127.0.0.1:5"), Some("tok"));
        let cmd = build_command(&with, 1);
        assert_eq!(get(&cmd, HOOK_URL_VAR).as_deref(), Some("http://127.0.0.1:5"));
        assert_eq!(get(&cmd, HOOK_TOKEN_VAR).as_deref(), Some("tok"));

        assert!(hook_env(None, None).is_empty());
        assert!(hook_env(Some("http://127.0.0.1:5"), None).is_empty());
        let cmd = build_command(&spec("bash", &[], None), 1);
        assert_eq!(get(&cmd, HOOK_URL_VAR), None);
        assert_eq!(get(&cmd, HOOK_TOKEN_VAR), None);
    }

    #[test]
    fn path_with_prepends_once() {
        let dir = Path::new(r"C:\Apps\Bashboard");
        let with = |v: Option<&str>| path_with(dir, v.map(OsStr::new)).to_string_lossy().into_owned();
        assert_eq!(with(None), r"C:\Apps\Bashboard");
        assert_eq!(with(Some("")), r"C:\Apps\Bashboard");
        assert_eq!(with(Some(r"C:\Windows;C:\Bin")), r"C:\Apps\Bashboard;C:\Windows;C:\Bin");
        let already = r"c:\apps\BASHBOARD;C:\Windows";
        assert_eq!(with(Some(already)), already);
        // Present but not first still gets the folder in front.
        assert_eq!(
            with(Some(r"C:\Windows;C:\Apps\Bashboard")),
            r"C:\Apps\Bashboard;C:\Windows;C:\Apps\Bashboard"
        );
    }

    #[test]
    fn path_env_replaces_the_single_path_variable() {
        let env = path_env();
        let dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        assert_eq!(env.len(), 1);
        let mut with = spec("bash", &[], None);
        with.env = env;
        let cmd = build_command(&with, 1);
        let path = cmd.get_env("PATH").and_then(|v| v.to_str()).unwrap().to_owned();
        assert!(path.to_lowercase().starts_with(&dir.to_string_lossy().to_lowercase()), "{path}");
        let path_like = cmd.iter_full_env_as_str().filter(|(k, _)| k.eq_ignore_ascii_case("PATH")).count();
        assert_eq!(path_like, 1);
    }

    #[test]
    fn shell_sees_exe_folder_on_path() {
        let Some(sh) = shell() else { return };
        let ptys = Ptys::default();
        let mut s = spec(&sh, &["--login", "-c", r#"echo "PATHIS:$(cygpath -wp "$PATH")""#], None);
        s.env = path_env();
        let run = start(&ptys, s);
        assert_eq!(run.wait_exit(), 0);
        let dir = std::env::current_exe().unwrap().parent().unwrap().to_string_lossy().to_lowercase();
        let text = run.wait_for("PATHIS:").to_lowercase();
        let after = text.split("pathis:").nth(1).unwrap_or("").to_owned();
        assert!(after.contains(&dir), "output was {text:?}");
    }

    #[test]
    fn contains_tracks_live_ptys() {
        let Some(sh) = shell() else { return };
        let ptys = Ptys::default();
        assert!(!ptys.contains(99));
        let run = start(&ptys, spec(&sh, &["-c", "sleep 30"], None));
        assert!(ptys.contains(run.id));
        ptys.kill(run.id).unwrap();
        run.wait_exit();
        assert!(!ptys.contains(run.id));
    }

    #[test]
    fn strips_inherited_session_vars() {
        let cmd = build_command(&spec("bash", &[], None), 1);
        assert!(cmd.get_env("CLAUDECODE").is_none());
        assert!(cmd.get_env("ORIGINAL_PATH").is_none());
        assert_eq!(cmd.get_env("BASHBOARD_PANE_ID").and_then(|v| v.to_str()), Some("1"));
    }

    #[test]
    fn login_shell_starts_in_requested_cwd() {
        let Some(sh) = shell() else { return };
        let leaf = format!("bashboard-pty-test-{}-{}", std::process::id(), now_ms());
        let dir = std::env::temp_dir().join(&leaf);
        std::fs::create_dir_all(&dir).unwrap();
        let ptys = Ptys::default();
        // --login runs the profile, which is what would otherwise change to the home directory.
        let run = start(&ptys, spec(&sh, &["--login", "-c", "pwd -W"], Some(dir.clone())));
        let code = run.wait_exit();
        // Match on the unique leaf only: CI runners' temp dir is an 8.3 short path
        // (RUNNER~1), which bash reports as given and canonicalize would expand.
        let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
        let want = format!("/{}", leaf.to_lowercase());
        let deadline = Instant::now() + TIMEOUT;
        let mut got = norm(&run.text());
        while !got.contains(&want) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
            got = norm(&run.text());
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(code, 0);
        assert!(got.contains(&want), "wanted {want:?} in {got:?}");
    }

    fn profile_for_test(id: &str) -> profiles::ShellProfile {
        profiles::ShellProfile { id: id.into(), path: "shell.exe".into(), args: vec!["-l".into()], name: id.into() }
    }

    #[test]
    fn command_replaces_profile_program_and_args() {
        let resolved = profile_for_test(profiles::CMD);
        let command = vec!["docker".to_string(), "exec".into(), "-it".into()];
        let spec = spawn_spec(Some(command), &resolved, Vec::new(), None).unwrap();
        assert_eq!(spec.program, "docker");
        assert_eq!(spec.args, vec!["exec", "-it"]);
        assert!(spec.env.iter().all(|(k, _)| k != "PROMPT"));

        let spec = spawn_spec(None, &resolved, Vec::new(), None).unwrap();
        assert_eq!(spec.program, "shell.exe");
        assert!(spec.env.iter().any(|(k, _)| k == "PROMPT"));
    }

    #[test]
    fn empty_command_is_rejected() {
        let resolved = profile_for_test(profiles::GIT_BASH);
        assert!(spawn_spec(Some(Vec::new()), &resolved, Vec::new(), None).is_err());
    }

    #[test]
    fn command_runs_in_place_of_the_profile() {
        let ptys = Ptys::default();
        let spec = spawn_spec(
            Some(vec!["cmd.exe".into(), "/c".into(), "echo hi".into()]),
            &profile_for_test(profiles::GIT_BASH),
            Vec::new(),
            None,
        )
        .unwrap();
        let run = start(&ptys, spec);
        assert_eq!(run.wait_exit(), 0);
        let text = run.wait_for("hi");
        assert!(text.contains("hi"), "output was {text:?}");
    }

    #[test]
    fn bare_command_name_resolves_through_path() {
        let ptys = Ptys::default();
        let spec = spawn_spec(
            Some(vec!["cmd".into(), "/c".into(), "echo hi".into()]),
            &profile_for_test(profiles::GIT_BASH),
            Vec::new(),
            None,
        )
        .unwrap();
        let run = start(&ptys, spec);
        assert_eq!(run.wait_exit(), 0);
        let text = run.wait_for("hi");
        assert!(text.contains("hi"), "output was {text:?}");
    }

    fn proc(parent: Option<u32>, name: &str) -> ProcEntry {
        ProcEntry { parent, name: name.into() }
    }

    #[test]
    fn launcher_chain_with_idle_shell_is_idle() {
        let procs: ProcNames = HashMap::from([
            (1, proc(Some(0), "bash.exe")),
            (2, proc(Some(1), "bash.exe")),
        ]);
        assert!(!shell_busy(1, &procs));
    }

    #[test]
    fn orphaned_nested_shell_is_judged_by_its_children() {
        let mut procs: ProcNames = HashMap::from([(7, proc(Some(99), "bash.exe"))]);
        assert!(!orphan_busy(7, &procs));
        procs.insert(8, proc(Some(7), "node.exe"));
        assert!(orphan_busy(7, &procs));
    }

    #[test]
    fn orphaned_job_is_busy() {
        let procs: ProcNames = HashMap::from([(7, proc(Some(99), "sleep.exe"))]);
        assert!(orphan_busy(7, &procs));
        assert!(!orphan_busy(8, &procs));
    }

    #[test]
    fn launcher_chain_with_running_job_is_busy() {
        let procs: ProcNames = HashMap::from([
            (1, proc(Some(0), "bash.exe")),
            (2, proc(Some(1), "bash.exe")),
            (3, proc(Some(2), "sleep.exe")),
        ]);
        assert!(shell_busy(1, &procs));
    }

    #[test]
    fn plain_shell_idle_and_busy() {
        let mut procs: ProcNames = HashMap::from([(1, proc(Some(0), "bash.exe"))]);
        assert!(!shell_busy(1, &procs));
        procs.insert(2, proc(Some(1), "node.exe"));
        assert!(shell_busy(1, &procs));
    }

    #[test]
    fn shell_with_several_children_is_busy_even_if_one_is_bash() {
        let procs: ProcNames = HashMap::from([
            (1, proc(Some(0), "bash.exe")),
            (2, proc(Some(1), "bash.exe")),
            (3, proc(Some(1), "sleep.exe")),
        ]);
        assert!(shell_busy(1, &procs));
    }

    #[test]
    fn lone_bash_child_is_descended_into() {
        let procs: ProcNames = HashMap::from([
            (1, proc(Some(0), "bash.exe")),
            (2, proc(Some(1), "bash.exe")),
            (3, proc(Some(2), "bash.exe")),
            (4, proc(Some(3), "git.exe")),
        ]);
        assert!(shell_busy(1, &procs));
    }

    #[test]
    fn cmd_prompt_reports_cwd_and_keeps_inherited_prompt() {
        assert_eq!(cmd_prompt(None), "$e]9;9;$P$e\\$P$G");
        assert_eq!(cmd_prompt(Some("")), "$e]9;9;$P$e\\$P$G");
        assert_eq!(cmd_prompt(Some("$T $P$_$G")), "$e]9;9;$P$e\\$T $P$_$G");
    }

    #[test]
    fn pwsh_and_cmd_are_busy_only_with_children() {
        for shell in ["pwsh.exe", "cmd.exe"] {
            let mut procs: ProcNames = HashMap::from([(1, proc(Some(0), shell))]);
            assert!(!shell_busy(1, &procs), "{shell} idle");
            procs.insert(2, proc(Some(1), "node.exe"));
            assert!(shell_busy(1, &procs), "{shell} running a job");
            // bash started from pwsh or cmd is a nested shell, judged by its own children.
            procs.insert(2, proc(Some(1), "bash.exe"));
            assert!(!shell_busy(1, &procs), "{shell} with idle nested bash");
            procs.insert(3, proc(Some(2), "sleep.exe"));
            assert!(shell_busy(1, &procs), "{shell} with busy nested bash");
        }
    }

    #[test]
    fn missing_process_is_idle() {
        let procs: ProcNames = HashMap::from([(5, proc(Some(0), "explorer.exe"))]);
        assert!(!shell_busy(1, &procs));
    }

    #[test]
    fn parent_cycle_terminates() {
        let procs: ProcNames = HashMap::from([
            (1, proc(Some(2), "bash.exe")),
            (2, proc(Some(1), "bash.exe")),
        ]);
        let _ = shell_busy(1, &procs);
    }

    #[test]
    fn activity_reports_busy_then_idle_around_a_job() {
        let Some(sh) = shell() else { return };
        let ptys = Ptys::default();
        let run = start(&ptys, spec(&sh, &["--login", "-i"], None));
        let mut activity = ActivityProbe::default();
        let mut probe = || ptys.activity(&mut activity).iter().find(|a| a.id == run.id).map(|a| a.busy);
        fn until(probe: &mut impl FnMut() -> Option<bool>, want: bool) -> bool {
            let deadline = Instant::now() + TIMEOUT;
            while Instant::now() < deadline {
                if probe() == Some(want) {
                    return true;
                }
                thread::sleep(Duration::from_millis(100));
            }
            false
        }
        // A user's prompt hooks (starship, __git_ps1, cygpath) spawn children while each prompt
        // renders, which correctly reads as busy and races the samples below; swap in a prompt
        // that spawns nothing. A shell that is still starting can drop typed input, so resend
        // until the marker shows; it is computed so the echoed command line cannot match it.
        let ready = |cmd: &[u8], marker: &str| {
            let deadline = Instant::now() + TIMEOUT;
            while !run.text().contains(marker) {
                assert!(
                    Instant::now() < deadline,
                    "no {marker:?} in {:?}",
                    run.text()
                );
                ptys.write(run.id, cmd).unwrap();
                let resend = Instant::now() + Duration::from_secs(1);
                while !run.text().contains(marker) && Instant::now() < resend {
                    thread::sleep(Duration::from_millis(20));
                }
            }
        };
        ready(
            b"trap - DEBUG; PS0=; PROMPT_COMMAND=; PS1='$ '; echo outer-ready-$((6*7))\r",
            "outer-ready-42",
        );
        assert!(until(&mut probe, false), "shell never went idle");
        ptys.write(run.id, b"sleep 3\r").unwrap();
        assert!(until(&mut probe, true), "never reported busy");
        assert!(until(&mut probe, false), "never returned to idle");

        // A nested shell sitting at its prompt is idle; a job inside it is busy. The prompt
        // settings above are not exported, so the nested shell's default prompt spawns nothing.
        ptys.write(run.id, b"bash --norc\r").unwrap();
        ready(b"echo nested-ready-$((6*7))\r", "nested-ready-42");
        for _ in 0..5 {
            assert_eq!(probe(), Some(false), "idle nested shell reported busy");
            thread::sleep(Duration::from_millis(100));
        }
        ptys.write(run.id, b"sleep 3\r").unwrap();
        assert!(until(&mut probe, true), "job in nested shell never reported busy");
        assert!(until(&mut probe, false), "nested shell never returned to idle");
        ptys.kill(run.id).unwrap();
        run.wait_exit();
    }

    #[test]
    fn list_kill_and_distinct_ids() {
        let Some(sh) = shell() else { return };
        let ptys = Ptys::default();
        let a = start(&ptys, spec(&sh, &["-c", "sleep 30"], None));
        let b = start(&ptys, spec(&sh, &["-c", "sleep 30"], None));
        assert!(b.id > a.id);

        let list = ptys.list();
        let info = list.iter().find(|p| p.id == a.id).expect("pane a listed");
        assert_ne!(info.pid, 0);
        assert_ne!(info.started_at, 0);
        assert!(list.iter().any(|p| p.id == b.id));

        ptys.kill(a.id).unwrap();
        a.wait_exit();
        assert!(ptys.list().iter().all(|p| p.id != a.id));
        ptys.kill(b.id).unwrap();
        b.wait_exit();
        assert!(ptys.list().is_empty());
    }
}
