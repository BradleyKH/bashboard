//! Session roster (design sections 3.2, 3.4, and 7): reads Claude Code's per-session files,
//! keeps only live sessions, binds each to the pane whose shell it runs under, and merges in what
//! hooks have reported.
//!
//! Agents that write no session file (Codex, Copilot) get hook-born sessions: one per overlay
//! entry carrying a pane id, built from the overlay alone. The 10 second sweep binds each to the
//! newest matching process under its pane's shell and ends it when that process dies, its pane
//! closes, or, with no process ever found, after 30 minutes without events. Codex names come
//! from its `session_index.jsonl`.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agents::AgentId;
use crate::hooks::{self, HookOverlay, HookStatus, Hooks};
use crate::pty::Ptys;
use crate::transcript::{self, Transcripts};

const SWEEP: Duration = Duration::from_secs(10);
const MAX_HOPS: usize = 32;
/// FILETIME and sysinfo start times come from different clocks and roundings.
const START_TOLERANCE_SECS: i64 = 2;
/// How long a hook-born session with no process found survives without events.
const HOOK_BORN_IDLE_MS: u64 = 30 * 60 * 1000;

/// A session file as Claude Code writes it. The format is undocumented, so every field is
/// optional, and fields the roster must never forward (messaging sockets, tokens, bridge ids)
/// have no slot here.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawSession {
    pid: Option<u32>,
    session_id: Option<String>,
    cwd: Option<String>,
    started_at: Option<u64>,
    proc_start: Option<String>,
    version: Option<String>,
    name: Option<String>,
    updated_at: Option<u64>,
    status: Option<String>,
    status_updated_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Busy,
    Idle,
    Waiting,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: String,
    pub pid: u32,
    pub name: Option<String>,
    pub cwd: String,
    pub status: SessionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_status: Option<String>,
    pub status_changed_at: u64,
    pub started_at: u64,
    pub version: Option<String>,
    pub pane_id: Option<u32>,
    /// The blocking notification's text while `status` is `Waiting`; serialized as null otherwise.
    pub waiting_reason: Option<String>,
    /// The newest permission mode a hook reported; omitted for a session that sent none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    pub agent: AgentId,
}

/// One running process as the liveness and ancestry checks need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub parent: Option<u32>,
    /// Unix seconds; 0 when the process could not be opened.
    pub start: u64,
    /// Executable file name.
    pub name: String,
    /// Full command line, known only for processes a command-line pass has read.
    pub cmd: Option<String>,
}

pub type ProcTable = HashMap<u32, ProcInfo>;

/// Parses one session file; `None` when it is not JSON or lacks `pid` or `sessionId`.
fn parse_raw(text: &str) -> Result<Option<RawSession>, serde_json::Error> {
    let raw: RawSession = serde_json::from_str(text)?;
    Ok((raw.pid.is_some() && raw.session_id.is_some()).then_some(raw))
}

fn to_session(raw: RawSession) -> Option<Session> {
    let (status, raw_status) = match raw.status.as_deref() {
        Some("busy") => (SessionStatus::Busy, None),
        Some("idle") => (SessionStatus::Idle, None),
        _ => (SessionStatus::Unknown, raw.status),
    };
    let started_at = raw.started_at.unwrap_or(0);
    Some(Session {
        session_id: raw.session_id?,
        pid: raw.pid?,
        name: raw.name.filter(|n| !n.is_empty()),
        cwd: raw.cwd.unwrap_or_default(),
        status,
        raw_status,
        status_changed_at: raw.status_updated_at.or(raw.updated_at).unwrap_or(started_at),
        started_at,
        version: raw.version,
        pane_id: None,
        waiting_reason: None,
        permission_mode: None,
        agent: AgentId::Claude,
    })
}

/// Converts a FILETIME (100 ns ticks since 1601-01-01) to unix seconds.
fn filetime_to_unix(ticks: u64) -> i64 {
    (ticks / 10_000_000) as i64 - 11_644_473_600
}

/// Live when the pid exists and, if `procStart` is usable, the process started at that time;
/// the start check catches a pid reused after a crash left a stale file behind.
fn is_live(pid: u32, proc_start: Option<&str>, procs: &ProcTable) -> bool {
    let Some(info) = procs.get(&pid) else { return false };
    match proc_start.and_then(|s| s.trim().parse::<u64>().ok()) {
        Some(ticks) => (info.start as i64 - filetime_to_unix(ticks)).abs() <= START_TOLERANCE_SECS,
        None => true,
    }
}

/// Walks parents from `pid` to the first pane shell pid and returns that pane's pty id.
fn bind_pane(pid: u32, shells: &HashMap<u32, u32>, procs: &ProcTable) -> Option<u32> {
    walk_to_pane(pid, shells, procs).map(|(pane, _)| pane)
}

/// `bind_pane` plus the number of hops taken (0 for the shell itself).
fn walk_to_pane(pid: u32, shells: &HashMap<u32, u32>, procs: &ProcTable) -> Option<(u32, usize)> {
    let mut cur = pid;
    let mut seen = HashSet::new();
    for hops in 0..=MAX_HOPS {
        if let Some(&pane) = shells.get(&cur) {
            return Some((pane, hops));
        }
        if !seen.insert(cur) {
            return None;
        }
        let info = procs.get(&cur)?;
        let parent = info.parent?;
        // Windows keeps a dead parent's pid, which may since belong to an unrelated process.
        let parent_start = procs.get(&parent).map_or(0, |p| p.start);
        if parent_start > info.start {
            return None;
        }
        cur = parent;
    }
    None
}

fn proc_table(sys: &mut System) -> ProcTable {
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes()
        .iter()
        .map(|(pid, p)| {
            let info = ProcInfo {
                parent: p.parent().map(|pp| pp.as_u32()),
                start: p.start_time(),
                name: p.name().to_string_lossy().into_owned(),
                cmd: cmd_line(p),
            };
            (pid.as_u32(), info)
        })
        .collect()
}

/// sysinfo keeps a command line read by an earlier pass, so this is set for any process
/// `fill_cmds` has seen.
fn cmd_line(p: &sysinfo::Process) -> Option<String> {
    let parts = p.cmd();
    (!parts.is_empty())
        .then(|| parts.iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" "))
}

/// Reads the command lines of `pids` into `procs`.
fn fill_cmds(sys: &mut System, procs: &mut ProcTable, pids: &[u32]) {
    let list: Vec<Pid> = pids.iter().map(|&p| Pid::from_u32(p)).collect();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&list),
        false,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    for pid in pids {
        if let (Some(p), Some(info)) = (sys.process(Pid::from_u32(*pid)), procs.get_mut(pid)) {
            info.cmd = cmd_line(p);
        }
    }
}

/// The newest process under `pane`'s shell that is `agent`. A launcher and the CLI it starts
/// can share a start second (VS Code's Copilot shim), so the deeper one wins a tie.
fn find_agent_pid(agent: AgentId, pane: u32, shells: &HashMap<u32, u32>, procs: &ProcTable) -> Option<u32> {
    procs
        .iter()
        .filter(|(_, p)| agent.agent().matches_process(&p.name, p.cmd.as_deref()))
        .filter_map(|(&pid, p)| match walk_to_pane(pid, shells, procs) {
            Some((found, hops)) if found == pane && hops > 0 => Some((p.start, hops, pid)),
            _ => None,
        })
        .max()
        .map(|(_, _, pid)| pid)
}

/// `node` processes under `pane`'s shell whose command line has not been read.
fn node_without_cmd(pane: u32, shells: &HashMap<u32, u32>, procs: &ProcTable) -> Vec<u32> {
    procs
        .iter()
        .filter(|(_, p)| p.cmd.is_none() && crate::agents::program_stem(&p.name) == "node")
        .filter(|(pid, _)| bind_pane(**pid, shells, procs) == Some(pane))
        .map(|(&pid, _)| pid)
        .collect()
}

/// What the sweep knows about hook-born sessions, keyed by session id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct HookBorn {
    /// The process bound to each session, as pid and start time.
    pids: HashMap<String, (u32, u64)>,
    /// Ended sessions with the overlay's `last_at` at the end; a newer event revives one, since
    /// resuming a thread reuses its id.
    ended: HashMap<String, u64>,
    names: HashMap<String, String>,
}

fn is_hook_born(id: &str, o: &HookOverlay, born: &HookBorn) -> bool {
    o.agent != AgentId::Claude
        && o.pane_id.is_some()
        && born.ended.get(id).map_or(true, |&at| o.last_at > at)
}

fn hook_born_ids(overlay: &HashMap<String, HookOverlay>, born: &HookBorn) -> Vec<String> {
    overlay.iter().filter(|(id, o)| is_hook_born(id, o, born)).map(|(id, _)| id.clone()).collect()
}

/// Binds hook-born sessions to processes and ends the ones whose process died, whose pane
/// closed, or that went 30 minutes without events with no process found. `fill_cmds` reads
/// command lines, called only when a `node` under the pane could be the agent.
fn sweep_hook_born(
    born: &mut HookBorn,
    overlay: &HashMap<String, HookOverlay>,
    procs: &mut ProcTable,
    shells: &HashMap<u32, u32>,
    now: u64,
    mut fill_cmds: impl FnMut(&mut ProcTable, &[u32]),
) {
    // An entry leaves the overlay on `SessionEnd` or when pruned.
    born.pids.retain(|id, _| overlay.contains_key(id));
    born.ended.retain(|id, _| overlay.contains_key(id));
    born.names.retain(|id, _| overlay.contains_key(id));
    let panes: HashSet<u32> = shells.values().copied().collect();
    for (id, o) in overlay {
        if !is_hook_born(id, o, born) {
            continue;
        }
        let Some(pane) = o.pane_id else { continue };
        let ended = if !panes.contains(&pane) {
            true
        } else if let Some(&(pid, start)) = born.pids.get(id) {
            procs.get(&pid).map_or(true, |p| p.start != start)
        } else {
            let found = find_agent_pid(o.agent, pane, shells, procs).or_else(|| {
                let need = node_without_cmd(pane, shells, procs);
                if need.is_empty() {
                    return None;
                }
                fill_cmds(procs, &need);
                find_agent_pid(o.agent, pane, shells, procs)
            });
            match found {
                Some(pid) => {
                    born.pids.insert(id.clone(), (pid, procs[&pid].start));
                    false
                }
                None => now.saturating_sub(o.last_at) >= HOOK_BORN_IDLE_MS,
            }
        };
        if ended {
            born.ended.insert(id.clone(), o.last_at);
            born.pids.remove(id);
        }
    }
}

/// Thread names from Codex's `session_index.jsonl` for the `wanted` ids; the last line for an id
/// wins, and an empty name counts as none.
fn codex_names(text: &str, wanted: &HashSet<&str>) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Line {
        id: String,
        thread_name: Option<String>,
    }
    let mut out = HashMap::new();
    for line in text.lines().filter_map(|l| serde_json::from_str::<Line>(l).ok()) {
        if !wanted.contains(line.id.as_str()) {
            continue;
        }
        match line.thread_name.filter(|n| !n.is_empty()) {
            Some(name) => out.insert(line.id, name),
            None => out.remove(&line.id),
        };
    }
    out
}

fn hook_born_sessions(overlay: &HashMap<String, HookOverlay>, born: &HookBorn) -> Vec<Session> {
    overlay
        .iter()
        .filter(|(id, o)| is_hook_born(id, o, born))
        .map(|(id, o)| {
            let (status, status_changed_at) = match o.status {
                Some((HookStatus::Busy, t)) => (SessionStatus::Busy, t),
                Some((HookStatus::Idle, t)) => (SessionStatus::Idle, t),
                Some((HookStatus::Waiting, t)) => (SessionStatus::Waiting, t),
                None => (SessionStatus::Unknown, o.first_at),
            };
            Session {
                session_id: id.clone(),
                // 0 until the sweep finds the process.
                pid: born.pids.get(id).map_or(0, |&(pid, _)| pid),
                name: born.names.get(id).cloned(),
                cwd: o.cwd.clone().unwrap_or_default(),
                status,
                raw_status: None,
                status_changed_at,
                started_at: o.first_at,
                version: None,
                pane_id: o.pane_id,
                waiting_reason: if status == SessionStatus::Waiting { o.waiting_message.clone() } else { None },
                permission_mode: o.permission_mode.clone(),
                agent: o.agent,
            }
        })
        .collect()
}

/// The session ids the overlay and transcript pruning treat as live.
fn live_ids<'a>(list: &'a [Session], hook_born: &'a [String]) -> HashSet<&'a str> {
    list.iter().map(|s| s.session_id.as_str()).chain(hook_born.iter().map(String::as_str)).collect()
}

struct Scanner {
    sys: System,
    /// Files already reported as unparseable, so a sweep does not repeat the warning.
    failed: HashSet<PathBuf>,
    /// The last scan's process table and pane shells (shell pid to pty id).
    procs: ProcTable,
    shells: HashMap<u32, u32>,
}

impl Scanner {
    fn new() -> Self {
        Self { sys: System::new(), failed: HashSet::new(), procs: ProcTable::new(), shells: HashMap::new() }
    }

    fn read_dir(&mut self, dir: &Path) -> Vec<RawSession> {
        let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut out = Vec::new();
        for path in entries.flatten().map(|e| e.path()) {
            // The directory also holds per-session key files, which must never be opened.
            if !is_session_file(&path) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            match parse_raw(&text) {
                Ok(raw) => {
                    self.failed.remove(&path);
                    out.extend(raw);
                }
                Err(e) => {
                    if self.failed.insert(path.clone()) {
                        eprintln!("roster: skipping {}: {e}", path.display());
                    }
                }
            }
        }
        out
    }

    fn scan(&mut self, dir: &Path, ptys: &Ptys) -> Vec<Session> {
        let raws = self.read_dir(dir);
        self.procs = proc_table(&mut self.sys);
        self.shells = ptys.list().into_iter().map(|p| (p.pid, p.id)).collect();
        build_list(raws, &self.procs, &self.shells)
    }

    /// Runs after `scan`, on its process table.
    fn sweep_hook_born(&mut self, born: &mut HookBorn, overlay: &HashMap<String, HookOverlay>, now: u64) {
        let sys = &mut self.sys;
        sweep_hook_born(born, overlay, &mut self.procs, &self.shells, now, |procs, pids| {
            fill_cmds(sys, procs, pids)
        });
        let unnamed: HashSet<&str> = overlay
            .iter()
            .filter(|(id, o)| {
                o.agent == AgentId::Codex && is_hook_born(id, o, born) && !born.names.contains_key(*id)
            })
            .map(|(id, _)| id.as_str())
            .collect();
        if unnamed.is_empty() {
            return;
        }
        let Some(home) = AgentId::Codex.agent().home() else { return };
        if let Ok(text) = std::fs::read_to_string(home.join("session_index.jsonl")) {
            born.names.extend(codex_names(&text, &unnamed));
        }
    }
}

fn is_session_file(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "json") && path.is_file()
}

fn build_list(raws: Vec<RawSession>, procs: &ProcTable, shells: &HashMap<u32, u32>) -> Vec<Session> {
    let mut list: Vec<Session> = raws
        .into_iter()
        .filter(|r| r.pid.is_some_and(|pid| is_live(pid, r.proc_start.as_deref(), procs)))
        .filter_map(to_session)
        .map(|mut s| {
            s.pane_id = bind_pane(s.pid, shells, procs);
            s
        })
        .collect();
    list.sort_by_key(|s| s.started_at);
    list
}

/// Merges hook overlays into the scanned sessions (design section 7). A header-bound pane wins
/// over ancestry. Hook busy or idle wins only when newer than the roster's status; waiting holds
/// against anything but a newer roster busy, since the session file never reports waiting and
/// would otherwise clear it on its next write. A waiting session carries the overlay's message
/// as its reason.
fn apply_overlay(sessions: &mut [Session], overlay: &HashMap<String, HookOverlay>) {
    for s in sessions {
        let Some(o) = overlay.get(&s.session_id) else { continue };
        if let Some(pane) = o.pane_id {
            s.pane_id = Some(pane);
        }
        let status = match o.status {
            Some((HookStatus::Busy, t)) if t > s.status_changed_at => Some((SessionStatus::Busy, t)),
            Some((HookStatus::Idle, t)) if t > s.status_changed_at => Some((SessionStatus::Idle, t)),
            Some((HookStatus::Waiting, t))
                if !(s.status == SessionStatus::Busy && s.status_changed_at > t) =>
            {
                Some((SessionStatus::Waiting, t))
            }
            _ => None,
        };
        if let Some((status, t)) = status {
            s.status = status;
            s.raw_status = None;
            s.status_changed_at = t;
        }
        s.waiting_reason =
            if s.status == SessionStatus::Waiting { o.waiting_message.clone() } else { None };
        s.permission_mode = o.permission_mode.clone();
    }
}

#[derive(Default)]
struct Lists {
    /// The last scan, before any hook overlay.
    scanned: Vec<Session>,
    /// The merged list last emitted.
    emitted: Vec<Session>,
    hook_born: HookBorn,
}

pub struct Roster {
    lists: Mutex<Lists>,
    // Held only so the watcher lives as long as the app.
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl Default for Roster {
    fn default() -> Self {
        Self { lists: Mutex::new(Lists::default()), watcher: Mutex::new(None) }
    }
}

#[tauri::command]
pub fn sessions_get(state: State<'_, Roster>) -> Vec<Session> {
    state.lists.lock().unwrap().emitted.clone()
}

/// Re-applies the current hook overlay to the last scan and emits `sessions://changed` if the
/// merged list differs from the last one emitted.
pub fn refresh(app: &AppHandle) {
    let overlay = app.state::<Hooks>().overlay();
    let state = app.state::<Roster>();
    // Emitting under the lock keeps emissions from the scan and hook threads in order.
    let merged = {
        let mut lists = state.lists.lock().unwrap();
        let mut merged = lists.scanned.clone();
        apply_overlay(&mut merged, &overlay);
        merged.extend(hook_born_sessions(&overlay, &lists.hook_born));
        merged.sort_by_key(|s| s.started_at);
        if lists.emitted != merged {
            lists.emitted = merged.clone();
            let _ = app.emit("sessions://changed", &merged);
        }
        merged
    };
    transcript::sync(app, &merged, &overlay);
}

fn sessions_dir() -> Option<PathBuf> {
    crate::platform::user_home().map(|home| home.join(".claude").join("sessions"))
}

fn try_watch(dir: &Path, tx: &mpsc::Sender<notify::Result<notify::Event>>) -> Option<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(tx.clone()).ok()?;
    watcher.watch(dir, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

/// Scans once, then rescans on directory changes and every 10 seconds, emitting
/// `sessions://changed` whenever the list differs from the last one emitted.
pub fn init(app: &AppHandle) {
    let Some(dir) = sessions_dir() else {
        eprintln!("roster: USERPROFILE not set, no sessions");
        return;
    };
    let ptys = app.state::<Ptys>().inner().clone();
    let mut scanner = Scanner::new();
    let rescan = {
        let app = app.clone();
        let dir = dir.clone();
        move |scanner: &mut Scanner| {
            let list = scanner.scan(&dir, &ptys);
            let overlay = app.state::<Hooks>().overlay();
            let roster = app.state::<Roster>();
            let now = hooks::now_ms();
            // Only this thread writes `hook_born`, so sweeping a copy outside the lock is safe and
            // keeps the hook thread's refresh from waiting on process and file reads.
            let mut born = roster.lists.lock().unwrap().hook_born.clone();
            scanner.sweep_hook_born(&mut born, &overlay, now);
            let born_ids = hook_born_ids(&overlay, &born);
            let live = live_ids(&list, &born_ids);
            app.state::<Hooks>().prune(&live, now);
            app.state::<Transcripts>().prune(&live);
            {
                let mut lists = roster.lists.lock().unwrap();
                lists.hook_born = born;
                lists.scanned = list;
            }
            refresh(&app);
        }
    };
    rescan(&mut scanner);

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let app = app.clone();
    let watch = move |tx: &mpsc::Sender<_>| {
        let state = app.state::<Roster>();
        let mut slot = state.watcher.lock().unwrap();
        if slot.is_none() {
            *slot = try_watch(&dir, tx);
        }
    };
    watch(&tx);

    thread::spawn(move || {
        let relevant = |ev: &notify::Result<notify::Event>| {
            ev.as_ref().is_ok_and(|e| e.paths.iter().any(|p| p.extension().is_some_and(|x| x == "json")))
        };
        loop {
            match rx.recv_timeout(SWEEP) {
                Ok(ev) => {
                    if !relevant(&ev) {
                        continue;
                    }
                    // Coalesce the burst of events a single write produces.
                    while rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
                }
                // The directory may not exist until Claude Code first runs.
                Err(mpsc::RecvTimeoutError::Timeout) => watch(&tx),
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            rescan(&mut scanner);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "pid": 278404,
        "sessionId": "86940a84-0000-4000-8000-000000000000",
        "cwd": "C:\\Users\\me\\repos\\app",
        "startedAt": 1792939849277,
        "procStart": "134374134486766877",
        "version": "2.1.310",
        "kind": "interactive",
        "entrypoint": "cli",
        "name": "app",
        "updatedAt": 1792952749589,
        "status": "busy",
        "statusUpdatedAt": 1792952749590,
        "messagingSocketPath": "\\\\.\\pipe\\fake-socket-path",
        "bridgeSessionId": "fake-bridge-id"
    }"#;

    fn session(json: &str) -> Session {
        to_session(parse_raw(json).unwrap().unwrap()).unwrap()
    }

    fn procs(entries: &[(u32, Option<u32>, u64)]) -> ProcTable {
        entries
            .iter()
            .map(|&(pid, parent, start)| {
                (pid, ProcInfo { parent, start, name: "bash.exe".into(), cmd: None })
            })
            .collect()
    }

    #[test]
    fn full_file_maps_and_drops_private_fields() {
        let s = session(SAMPLE);
        assert_eq!(s.pid, 278404);
        assert_eq!(s.name.as_deref(), Some("app"));
        assert_eq!(s.cwd, r"C:\Users\me\repos\app");
        assert_eq!(s.status, SessionStatus::Busy);
        assert_eq!(s.raw_status, None);
        assert_eq!(s.status_changed_at, 1792952749590);
        assert_eq!(s.started_at, 1792939849277);
        assert_eq!(s.version.as_deref(), Some("2.1.310"));
        assert_eq!(s.pane_id, None);

        let out = serde_json::to_string(&s).unwrap();
        for leaked in
            ["messagingSocketPath", "fake-socket-path", "bridgeSessionId", "fake-bridge-id", "rawStatus"]
        {
            assert!(!out.contains(leaked), "{leaked} in {out}");
        }
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["sessionId"], "86940a84-0000-4000-8000-000000000000");
        assert_eq!(v["status"], "busy");
        assert_eq!(v["paneId"], serde_json::Value::Null);
        assert_eq!(v["statusChangedAt"], 1792952749590u64);
    }

    #[test]
    fn malformed_json_is_an_error() {
        assert!(parse_raw("{ not json").is_err());
        assert!(parse_raw(r#"{"pid": "nope", "sessionId": "a"}"#).is_err());
    }

    #[test]
    fn missing_pid_or_session_id_is_skipped() {
        assert!(parse_raw(r#"{"sessionId": "a"}"#).unwrap().is_none());
        assert!(parse_raw(r#"{"pid": 1}"#).unwrap().is_none());
    }

    #[test]
    fn missing_optional_fields_default() {
        let s = session(r#"{"pid": 7, "sessionId": "a", "startedAt": 100, "name": ""}"#);
        assert_eq!(s.name, None);
        assert_eq!(s.cwd, "");
        assert_eq!(s.version, None);
        assert_eq!(s.status, SessionStatus::Unknown);
        assert_eq!(s.raw_status, None);
        assert_eq!(s.status_changed_at, 100);
        let out = serde_json::to_string(&s).unwrap();
        assert!(!out.contains("rawStatus"), "{out}");

        let s = session(r#"{"pid": 7, "sessionId": "a", "startedAt": 100, "updatedAt": 200}"#);
        assert_eq!(s.status_changed_at, 200);
    }

    #[test]
    fn unknown_status_keeps_raw() {
        let s = session(r#"{"pid": 7, "sessionId": "a", "status": "compacting"}"#);
        assert_eq!(s.status, SessionStatus::Unknown);
        assert_eq!(s.raw_status.as_deref(), Some("compacting"));
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(v["status"], "unknown");
        assert_eq!(v["rawStatus"], "compacting");
        assert_eq!(session(r#"{"pid": 7, "sessionId": "a", "status": "idle"}"#).status, SessionStatus::Idle);
    }

    #[test]
    fn filetime_converts_to_unix_seconds() {
        assert_eq!(filetime_to_unix(134374362796412897), 1792962679);
        assert_eq!(filetime_to_unix(116444736000000000), 0);
    }

    #[test]
    fn liveness() {
        let table = procs(&[(10, None, 1792962680)]);
        assert!(is_live(10, Some("134374362796412897"), &table));
        // Same pid, but a process started an hour later: the pid was reused.
        let reused = procs(&[(10, None, 1792966279)]);
        assert!(!is_live(10, Some("134374362796412897"), &reused));
        assert!(is_live(10, None, &table));
        assert!(is_live(10, Some("garbage"), &table));
        assert!(!is_live(11, None, &table));
    }

    #[test]
    fn build_list_drops_dead_sorts_and_binds() {
        let raws = vec![
            parse_raw(r#"{"pid": 3, "sessionId": "late", "startedAt": 300}"#).unwrap().unwrap(),
            parse_raw(r#"{"pid": 2, "sessionId": "early", "startedAt": 200}"#).unwrap().unwrap(),
            parse_raw(r#"{"pid": 99, "sessionId": "dead", "startedAt": 100}"#).unwrap().unwrap(),
        ];
        let table = procs(&[(1, None, 10), (2, Some(1), 20), (3, None, 30)]);
        let shells = HashMap::from([(1, 5)]);
        let list = build_list(raws, &table, &shells);
        let ids: Vec<_> = list.iter().map(|s| (s.session_id.as_str(), s.pane_id)).collect();
        assert_eq!(ids, [("early", Some(5)), ("late", None)]);
    }

    #[test]
    fn ancestry() {
        let shells = HashMap::from([(100, 7)]);
        // 100 launcher -> 101 bash -> 102 claude; 200 is unrelated.
        let table =
            procs(&[(100, Some(1), 10), (101, Some(100), 11), (102, Some(101), 12), (200, Some(1), 10)]);
        assert_eq!(bind_pane(101, &shells, &table), Some(7));
        assert_eq!(bind_pane(102, &shells, &table), Some(7));
        assert_eq!(bind_pane(100, &shells, &table), Some(7));
        assert_eq!(bind_pane(200, &shells, &table), None);
        assert_eq!(bind_pane(999, &shells, &table), None);
    }

    #[test]
    fn ancestry_cycle_terminates() {
        let table = procs(&[(1, Some(2), 10), (2, Some(1), 10)]);
        assert_eq!(bind_pane(1, &HashMap::from([(50, 1)]), &table), None);
    }

    #[test]
    fn ancestry_stops_at_reused_parent_pid() {
        // 102's real parent died and pid 100 now belongs to a shell started after 102.
        let shells = HashMap::from([(100, 7)]);
        let table = procs(&[(100, None, 50), (102, Some(100), 12)]);
        assert_eq!(bind_pane(102, &shells, &table), None);
    }

    fn merged(status: &str, changed_at: u64, overlay: HookOverlay) -> Session {
        let mut list = vec![session(&format!(
            r#"{{"pid": 7, "sessionId": "a", "status": "{status}", "statusUpdatedAt": {changed_at}}}"#
        ))];
        list[0].pane_id = Some(1);
        apply_overlay(&mut list, &HashMap::from([("a".to_string(), overlay)]));
        list.remove(0)
    }

    fn hook(status: HookStatus, at: u64) -> HookOverlay {
        HookOverlay { status: Some((status, at)), pane_id: None, last_at: at, ..Default::default() }
    }

    #[test]
    fn waiting_overlay_carries_its_reason() {
        let overlay = HookOverlay {
            waiting_message: Some("Claude needs your permission to use Bash".into()),
            ..hook(HookStatus::Waiting, 150)
        };
        let s = merged("idle", 100, overlay.clone());
        assert_eq!(s.status, SessionStatus::Waiting);
        assert_eq!(s.waiting_reason.as_deref(), Some("Claude needs your permission to use Bash"));

        let s = merged("busy", 200, overlay);
        assert_eq!(s.status, SessionStatus::Busy);
        assert_eq!(s.waiting_reason, None);
    }

    #[test]
    fn waiting_reason_serializes_always() {
        let overlay = HookOverlay { waiting_message: Some("why".into()), ..hook(HookStatus::Waiting, 150) };
        let json = serde_json::to_value(merged("idle", 100, overlay)).unwrap();
        assert_eq!(json["waitingReason"], "why");
        let json = serde_json::to_value(merged("idle", 100, HookOverlay::default())).unwrap();
        assert!(json.as_object().unwrap().contains_key("waitingReason"));
        assert!(json["waitingReason"].is_null());
    }

    #[test]
    fn overlay_carries_permission_mode() {
        let overlay = HookOverlay { permission_mode: Some("bypassPermissions".into()), ..hook(HookStatus::Idle, 150) };
        let json = serde_json::to_value(merged("idle", 100, overlay)).unwrap();
        assert_eq!(json["permissionMode"], "bypassPermissions");
        let json = serde_json::to_value(merged("idle", 100, HookOverlay::default())).unwrap();
        assert!(!json.as_object().unwrap().contains_key("permissionMode"));
    }

    #[test]
    fn overlay_pane_overrides_ancestry() {
        let s = merged("idle", 100, HookOverlay { pane_id: Some(9), last_at: 50, ..Default::default() });
        assert_eq!((s.pane_id, s.status, s.status_changed_at), (Some(9), SessionStatus::Idle, 100));
        assert_eq!(merged("idle", 100, hook(HookStatus::Busy, 50)).pane_id, Some(1));
    }

    #[test]
    fn newer_hook_busy_or_idle_wins_older_loses() {
        let s = merged("idle", 100, hook(HookStatus::Busy, 200));
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Busy, 200));
        let s = merged("busy", 100, hook(HookStatus::Idle, 200));
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Idle, 200));
        let s = merged("idle", 300, hook(HookStatus::Busy, 200));
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Idle, 300));
        let s = merged("busy", 200, hook(HookStatus::Idle, 200));
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Busy, 200));
    }

    #[test]
    fn waiting_survives_newer_idle_and_unknown() {
        let s = merged("idle", 300, hook(HookStatus::Waiting, 200));
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Waiting, 200));
        let s = merged("compacting", 300, hook(HookStatus::Waiting, 200));
        assert_eq!((s.status, s.status_changed_at, s.raw_status), (SessionStatus::Waiting, 200, None));
    }

    #[test]
    fn waiting_cleared_only_by_newer_busy() {
        let s = merged("busy", 300, hook(HookStatus::Waiting, 200));
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Busy, 300));
        let s = merged("busy", 100, hook(HookStatus::Waiting, 200));
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Waiting, 200));
    }

    #[test]
    fn sessions_without_overlay_are_untouched() {
        let mut list = vec![session(SAMPLE)];
        list[0].pane_id = Some(4);
        let before = list.clone();
        let overlay = HashMap::from([("other".to_string(), hook(HookStatus::Waiting, u64::MAX))]);
        apply_overlay(&mut list, &overlay);
        assert_eq!(list, before);
    }

    #[test]
    fn waiting_serializes() {
        let s = merged("idle", 100, hook(HookStatus::Waiting, 200));
        assert_eq!(serde_json::to_value(&s).unwrap()["status"], "waiting");
    }

    fn proc(parent: u32, start: u64, name: &str, cmd: Option<&str>) -> ProcInfo {
        ProcInfo { parent: Some(parent), start, name: name.into(), cmd: cmd.map(Into::into) }
    }

    fn born_overlay(agent: AgentId, pane: Option<u32>, last_at: u64) -> HookOverlay {
        HookOverlay {
            status: Some((HookStatus::Busy, last_at)),
            pane_id: pane,
            last_at,
            agent,
            cwd: Some("C:\\work".into()),
            first_at: 10,
            ..Default::default()
        }
    }

    /// Shell 100 is pane 7: 100 bash -> 101 codex.exe.
    fn codex_tree() -> (ProcTable, HashMap<u32, u32>) {
        let mut table = procs(&[(100, Some(1), 10)]);
        table.insert(101, proc(100, 11, "codex.exe", None));
        (table, HashMap::from([(100, 7)]))
    }

    fn no_cmds(_: &mut ProcTable, _: &[u32]) {
        panic!("no command line pass expected");
    }

    #[test]
    fn hook_born_session_built_from_overlay() {
        let overlay = HashMap::from([
            ("cx".to_string(), born_overlay(AgentId::Codex, Some(7), 50)),
            // Claude sessions come from session files, and a paneless entry is not ours.
            ("cl".to_string(), born_overlay(AgentId::Claude, Some(7), 50)),
            ("np".to_string(), born_overlay(AgentId::Copilot, None, 50)),
        ]);
        let list = hook_born_sessions(&overlay, &HookBorn::default());
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.session_id, "cx");
        assert_eq!(s.agent, AgentId::Codex);
        assert_eq!((s.pid, s.started_at, s.pane_id), (0, 10, Some(7)));
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Busy, 50));
        assert_eq!(s.cwd, r"C:\work");
        assert_eq!((s.version.as_deref(), s.name.as_deref()), (None, None));
        let v = serde_json::to_value(s).unwrap();
        assert_eq!(v["agent"], "codex");

        let waiting = HookOverlay {
            status: Some((HookStatus::Waiting, 60)),
            waiting_message: Some("Approve?".into()),
            ..born_overlay(AgentId::Copilot, Some(7), 60)
        };
        let s = hook_born_sessions(&HashMap::from([("cp".to_string(), waiting)]), &HookBorn::default())
            .remove(0);
        assert_eq!((s.status, s.waiting_reason.as_deref()), (SessionStatus::Waiting, Some("Approve?")));
        let none = HookOverlay { status: None, ..born_overlay(AgentId::Codex, Some(7), 60) };
        let s = hook_born_sessions(&HashMap::from([("n".to_string(), none)]), &HookBorn::default())
            .remove(0);
        assert_eq!((s.status, s.status_changed_at), (SessionStatus::Unknown, 10));
    }

    #[test]
    fn file_born_sessions_are_claude() {
        assert_eq!(session(SAMPLE).agent, AgentId::Claude);
        assert_eq!(serde_json::to_value(session(SAMPLE)).unwrap()["agent"], "claude");
    }

    #[test]
    fn sweep_binds_codex_pid() {
        let (mut table, shells) = codex_tree();
        let overlay = HashMap::from([("cx".to_string(), born_overlay(AgentId::Codex, Some(7), 50))]);
        let mut born = HookBorn::default();
        sweep_hook_born(&mut born, &overlay, &mut table, &shells, 100, no_cmds);
        assert_eq!(born.pids.get("cx"), Some(&(101, 11)));
        assert_eq!(hook_born_sessions(&overlay, &born)[0].pid, 101);
    }

    #[test]
    fn sweep_reads_node_cmd_for_copilot() {
        let mut table = procs(&[(100, Some(1), 10)]);
        table.insert(101, proc(100, 11, "node.exe", None));
        table.insert(102, proc(100, 12, "node.exe", None));
        let shells = HashMap::from([(100, 7)]);
        let overlay = HashMap::from([("cp".to_string(), born_overlay(AgentId::Copilot, Some(7), 50))]);
        let mut born = HookBorn::default();
        let mut asked = Vec::new();
        sweep_hook_born(&mut born, &overlay, &mut table, &shells, 100, |t, pids| {
            asked = pids.to_vec();
            t.get_mut(&101).unwrap().cmd =
                Some(r"node.exe C:\npm\node_modules\@github\copilot\index.js".into());
            t.get_mut(&102).unwrap().cmd = Some("node.exe server.js".into());
        });
        asked.sort();
        assert_eq!(asked, [101, 102]);
        assert_eq!(born.pids.get("cp"), Some(&(101, 11)));
    }

    #[test]
    fn deeper_cli_beats_vs_code_shim() {
        // 100 bash -> 101 copilot.exe (VS Code's shim) -> 102 node.exe (the real CLI), same second.
        let mut table = procs(&[(100, Some(1), 10)]);
        table.insert(101, proc(100, 11, "copilot.exe", None));
        table.insert(102, proc(101, 11, "node.exe", Some("node /x/node_modules/@github/copilot/index.js")));
        let shells = HashMap::from([(100, 7)]);
        assert_eq!(find_agent_pid(AgentId::Copilot, 7, &shells, &table), Some(102));
        // Another pane's process is never chosen.
        assert_eq!(find_agent_pid(AgentId::Copilot, 8, &shells, &table), None);
        assert_eq!(find_agent_pid(AgentId::Codex, 7, &shells, &table), None);
    }

    #[test]
    fn ends_when_overlay_entry_goes() {
        let (mut table, shells) = codex_tree();
        let overlay = HashMap::from([("cx".to_string(), born_overlay(AgentId::Codex, Some(7), 50))]);
        let mut born = HookBorn::default();
        sweep_hook_born(&mut born, &overlay, &mut table, &shells, 100, no_cmds);
        let gone = HashMap::new();
        sweep_hook_born(&mut born, &gone, &mut table, &shells, 200, no_cmds);
        assert_eq!(born, HookBorn::default());
        assert!(hook_born_sessions(&gone, &born).is_empty());
    }

    #[test]
    fn ends_when_pid_dies_and_revives_on_new_event() {
        let (mut table, shells) = codex_tree();
        let mut overlay = HashMap::from([("cx".to_string(), born_overlay(AgentId::Codex, Some(7), 50))]);
        let mut born = HookBorn::default();
        sweep_hook_born(&mut born, &overlay, &mut table, &shells, 100, no_cmds);
        table.remove(&101);
        sweep_hook_born(&mut born, &overlay, &mut table, &shells, 200, no_cmds);
        assert!(hook_born_sessions(&overlay, &born).is_empty());
        assert!(hook_born_ids(&overlay, &born).is_empty());

        // A reused pid with a later start is not the same process.
        let (mut table, shells) = codex_tree();
        let mut born2 = HookBorn::default();
        sweep_hook_born(&mut born2, &overlay, &mut table, &shells, 100, no_cmds);
        table.get_mut(&101).unwrap().start = 99;
        sweep_hook_born(&mut born2, &overlay, &mut table, &shells, 200, no_cmds);
        assert!(hook_born_ids(&overlay, &born2).is_empty());

        overlay.get_mut("cx").unwrap().last_at = 300;
        assert_eq!(hook_born_ids(&overlay, &born), ["cx"]);
    }

    #[test]
    fn ends_when_pane_closes() {
        let (mut table, _) = codex_tree();
        let overlay = HashMap::from([("cx".to_string(), born_overlay(AgentId::Codex, Some(7), 50))]);
        let mut born = HookBorn::default();
        sweep_hook_born(&mut born, &overlay, &mut table, &HashMap::new(), 100, no_cmds);
        assert!(hook_born_ids(&overlay, &born).is_empty());
    }

    #[test]
    fn pidless_session_ends_after_thirty_quiet_minutes() {
        let mut table = procs(&[(100, Some(1), 10)]);
        let shells = HashMap::from([(100, 7)]);
        let overlay = HashMap::from([("cx".to_string(), born_overlay(AgentId::Codex, Some(7), 50))]);
        let mut born = HookBorn::default();
        sweep_hook_born(&mut born, &overlay, &mut table, &shells, 50 + HOOK_BORN_IDLE_MS - 1, no_cmds);
        assert_eq!(hook_born_ids(&overlay, &born), ["cx"]);
        sweep_hook_born(&mut born, &overlay, &mut table, &shells, 50 + HOOK_BORN_IDLE_MS, no_cmds);
        assert!(hook_born_ids(&overlay, &born).is_empty());
    }

    #[test]
    fn quiet_session_with_matching_descendant_lives() {
        let (mut table, shells) = codex_tree();
        let overlay = HashMap::from([("cx".to_string(), born_overlay(AgentId::Codex, Some(7), 50))]);
        let mut born = HookBorn::default();
        sweep_hook_born(&mut born, &overlay, &mut table, &shells, 50 + 2 * HOOK_BORN_IDLE_MS, no_cmds);
        assert_eq!(hook_born_ids(&overlay, &born), ["cx"]);
    }

    #[test]
    fn codex_names_last_line_wins() {
        let text = concat!(
            r#"{"id":"a","thread_name":"first","updated_at":1}"#, "\n",
            "not json\n",
            r#"{"id":"b","thread_name":"other","updated_at":2}"#, "\n",
            r#"{"id":"a","thread_name":"renamed","updated_at":3}"#, "\n",
            r#"{"id":"c","thread_name":"gone","updated_at":4}"#, "\n",
            r#"{"id":"c","thread_name":"","updated_at":5}"#, "\n",
        );
        let dir = std::env::temp_dir().join(format!("bashboard-roster-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session_index.jsonl");
        std::fs::write(&path, text).unwrap();
        let read = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let names = codex_names(&read, &HashSet::from(["a", "c"]));
        assert_eq!(names, HashMap::from([("a".to_string(), "renamed".to_string())]));
    }

    #[test]
    fn prune_live_set_keeps_hook_born() {
        let overlay = HashMap::from([
            ("cx".to_string(), born_overlay(AgentId::Codex, Some(7), 50)),
            ("old".to_string(), born_overlay(AgentId::Codex, Some(7), 50)),
        ]);
        let born = HookBorn { ended: HashMap::from([("old".to_string(), 50)]), ..Default::default() };
        let ids = hook_born_ids(&overlay, &born);
        let list = vec![session(SAMPLE)];
        let live = live_ids(&list, &ids);
        assert_eq!(live, HashSet::from(["86940a84-0000-4000-8000-000000000000", "cx"]));

    }

    #[test]
    fn live_descendant_binds_to_its_pty() {
        use std::time::Instant;
        const DEFAULT_SHELL: &str = crate::settings::DEFAULT_GIT_BASH_PATH;
        let sh = std::env::var("BASHBOARD_SHELL").unwrap_or_else(|_| DEFAULT_SHELL.into());
        if !Path::new(&sh).is_file() {
            println!("skipping: no shell at {sh}");
            return;
        }
        let ptys = Ptys::default();
        let (dsr_tx, dsr_rx) = mpsc::channel::<()>();
        let (id, _) = ptys
            .spawn(
                crate::pty::SpawnSpec {
                    program: sh,
                    args: vec!["-c".into(), "sleep 5".into()],
                    cwd: None,
                    env: Vec::new(),
                },
                80,
                24,
                move |b| {
                    if b.windows(4).any(|w| w == b"\x1b[6n") {
                        let _ = dsr_tx.send(());
                    }
                    true
                },
                |_| {},
            )
            .expect("spawn failed");
        // ConPTY holds the child until its cursor position query is answered.
        let responder = ptys.clone();
        thread::spawn(move || {
            while dsr_rx.recv().is_ok() {
                let _ = responder.write(id, b"\x1b[1;1R");
            }
        });

        let shell_pid = ptys.list().iter().find(|p| p.id == id).expect("pty listed").pid;
        let shells: HashMap<u32, u32> = ptys.list().into_iter().map(|p| (p.pid, p.id)).collect();
        let mut sys = System::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        let found = loop {
            let table = proc_table(&mut sys);
            let sleeper = sys
                .processes()
                .iter()
                .filter(|(_, p)| p.name().to_string_lossy().to_lowercase().starts_with("sleep"))
                .map(|(pid, _)| pid.as_u32())
                .find(|&pid| bind_pane(pid, &shells, &table) == Some(id));
            if sleeper.is_some() || Instant::now() > deadline {
                break sleeper.map(|pid| (pid, table));
            }
            thread::sleep(Duration::from_millis(100));
        };
        let _ = ptys.kill(id);
        let (pid, table) = found.expect("no descendant of the pty bound to it");
        assert_ne!(pid, shell_pid);
        assert_ne!(table[&pid].parent, Some(shell_pid), "expected at least two hops below the pty");
    }
}
