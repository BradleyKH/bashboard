//! Docker and Podman container support (docs/design.md section 3.10): parsing each engine's
//! CLI output into the shared `Container` shape, engine detection, the `containers_*`
//! commands, and the per-engine `events` watcher that emits `containers://changed`.
//!
//! The CLIs' `--format json` output is not a stable contract (section 12), so every field is
//! optional: an element that is not an object is skipped, and a missing field takes an empty
//! or `unknown` value, so a format change degrades a row rather than the list.
//!
//! Every CLI runs with an argument list, never through a shell, and ids follow `--` (section 9).

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, Manager, State,
    ipc::{Channel, InvokeResponseBody},
};

use crate::editors::hide_console;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Docker,
    Podman,
}

impl Engine {
    /// The CLI program name.
    pub fn cli(self) -> &'static str {
        match self {
            Engine::Docker => "docker",
            Engine::Podman => "podman",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerState {
    Running,
    Paused,
    Exited,
    Created,
    Restarting,
    Dead,
    Unknown,
}

impl ContainerState {
    fn parse(text: &str) -> Self {
        match text.trim().to_ascii_lowercase().as_str() {
            "running" => Self::Running,
            "paused" => Self::Paused,
            // Podman reports a stopped container as "stopped" as well as "exited".
            "exited" | "stopped" => Self::Exited,
            "created" => Self::Created,
            "restarting" => Self::Restarting,
            "dead" => Self::Dead,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub host: u16,
    pub container: u16,
    pub protocol: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub engine: Engine,
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: ContainerState,
    pub status_text: String,
    pub ports: Vec<Port>,
    pub project: Option<String>,
    pub service: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineState {
    pub engine: Engine,
    pub running: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainersSnapshot {
    pub engines: Vec<EngineState>,
    pub containers: Vec<Container>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    pub engine: Engine,
    pub id: String,
    pub cpu_percent: Option<f64>,
    pub mem_usage: Option<String>,
    pub mem_percent: Option<f64>,
}

/// The string at the first of `keys` that holds one, else empty.
fn text(obj: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

/// Compose project and service from a label lookup, docker-compose labels first.
fn compose(get: impl Fn(&str) -> Option<String>) -> (Option<String>, Option<String>) {
    let project = non_empty(get("com.docker.compose.project"))
        .or_else(|| non_empty(get("io.podman.compose.project")));
    let service = non_empty(get("com.docker.compose.service"))
        .or_else(|| non_empty(get("io.podman.compose.service")));
    (project, service)
}

/// Docker's `Labels` is one string, `k=v,k=v`. A value can itself hold commas, so a segment
/// with no `=` is ignored rather than treated as a new label.
fn docker_labels(text: &str) -> Vec<(String, String)> {
    text.split(',')
        .filter_map(|seg| {
            seg.split_once('=')
                .map(|(k, v)| (k.trim().to_string(), v.to_string()))
        })
        .collect()
}

fn push_unique(ports: &mut Vec<Port>, port: Port) {
    if !ports.contains(&port) {
        ports.push(port);
    }
}

fn parse_range(s: &str) -> Option<(u16, u16)> {
    match s.split_once('-') {
        Some((a, b)) => Some((a.trim().parse().ok()?, b.trim().parse().ok()?)),
        None => {
            let n = s.trim().parse().ok()?;
            Some((n, n))
        }
    }
}

/// Docker's `Ports` text, e.g. `0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 6379/tcp`. Entries
/// with no host side are dropped; the IPv4 and IPv6 forms of one mapping collapse into one.
/// A host range maps to the container range pairwise when both have the same length.
fn docker_ports(text: &str) -> Vec<Port> {
    let mut ports = Vec::new();
    for entry in text.split(',') {
        let entry = entry.trim();
        let Some((host_part, rest)) = entry.split_once("->") else {
            continue;
        };
        // The host port follows the last colon; the address before it may be IPv6.
        let host_ports = host_part.rsplit_once(':').map_or(host_part, |(_, p)| p);
        let (container_ports, protocol) = rest.split_once('/').unwrap_or((rest, "tcp"));
        let (Some((h0, h1)), Some((c0, c1))) =
            (parse_range(host_ports), parse_range(container_ports))
        else {
            continue;
        };
        if h1 < h0 || c1 < c0 || h1 - h0 != c1 - c0 {
            continue;
        }
        for i in 0..=(h1 - h0) {
            push_unique(
                &mut ports,
                Port {
                    host: h0 + i,
                    container: c0 + i,
                    protocol: protocol.trim().to_string(),
                },
            );
        }
    }
    ports
}

fn json_lines(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .filter(Value::is_object)
}

fn json_array_objects(text: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(text.trim()) {
        Ok(Value::Array(items)) => items.into_iter().filter(Value::is_object).collect(),
        _ => Vec::new(),
    }
}

/// Parses `docker ps -a --format json`: one JSON object per line.
pub fn parse_docker_ps(text: &str) -> Vec<Container> {
    json_lines(text)
        .map(|v| {
            let labels = docker_labels(&self::text(&v, &["Labels"]));
            let (project, service) = compose(|k| {
                labels
                    .iter()
                    .find(|(lk, _)| lk == k)
                    .map(|(_, lv)| lv.clone())
            });
            // `Names` can list several comma-separated names when linked; the first is the
            // container's own.
            let names = self::text(&v, &["Names"]);
            let name = names.split(',').next().unwrap_or("").to_string();
            Container {
                engine: Engine::Docker,
                id: self::text(&v, &["ID"]),
                name,
                image: self::text(&v, &["Image"]),
                state: ContainerState::parse(&self::text(&v, &["State"])),
                status_text: self::text(&v, &["Status"]),
                ports: docker_ports(&self::text(&v, &["Ports"])),
                project,
                service,
            }
        })
        .collect()
}

fn as_u16(v: Option<&Value>) -> Option<u16> {
    match v? {
        Value::Number(n) => n.as_u64().and_then(|n| u16::try_from(n).ok()),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn podman_ports(list: Option<&Value>) -> Vec<Port> {
    let mut ports = Vec::new();
    let Some(Value::Array(list)) = list else {
        return ports;
    };
    for p in list.iter().filter(|p| p.is_object()) {
        let (Some(host), Some(container)) =
            (as_u16(p.get("host_port")), as_u16(p.get("container_port")))
        else {
            continue;
        };
        if host == 0 {
            continue;
        }
        let protocol = match text(p, &["protocol"]) {
            s if s.is_empty() => "tcp".to_string(),
            s => s,
        };
        // `range` is the number of consecutive ports the mapping covers (1 when absent);
        // each is expanded so every published port gets its own link.
        let count = as_u16(p.get("range")).unwrap_or(1).max(1);
        for i in 0..count {
            let (Some(h), Some(c)) = (host.checked_add(i), container.checked_add(i)) else {
                break;
            };
            push_unique(
                &mut ports,
                Port {
                    host: h,
                    container: c,
                    protocol: protocol.clone(),
                },
            );
        }
    }
    ports
}

/// Parses `podman ps -a --format json`: one JSON array.
pub fn parse_podman_ps(text: &str) -> Vec<Container> {
    json_array_objects(text)
        .iter()
        .map(|v| {
            let name = match v.get("Names") {
                Some(Value::Array(names)) => names
                    .iter()
                    .find_map(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            let labels = v.get("Labels").and_then(Value::as_object);
            let (project, service) = compose(|k| {
                labels
                    .and_then(|l| l.get(k))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            Container {
                engine: Engine::Podman,
                id: self::text(v, &["Id"]),
                name,
                image: self::text(v, &["Image"]),
                state: ContainerState::parse(&self::text(v, &["State"])),
                status_text: self::text(v, &["Status"]),
                ports: podman_ports(v.get("Ports")),
                project,
                service,
            }
        })
        .collect()
}

/// A percentage given as `"1.23%"` text or a bare number.
fn percent(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('%').trim().parse().ok(),
        _ => None,
    }
}

struct StatsKeys {
    id: &'static [&'static str],
    cpu: &'static [&'static str],
    mem: &'static [&'static str],
    pct: &'static [&'static str],
}

fn stats_from(engine: Engine, v: &Value, keys: &StatsKeys) -> ContainerStats {
    let first = |ks: &[&str]| ks.iter().find_map(|k| v.get(*k));
    ContainerStats {
        engine,
        id: text(v, keys.id),
        cpu_percent: percent(first(keys.cpu)),
        mem_usage: Some(text(v, keys.mem)).filter(|s| !s.is_empty()),
        mem_percent: percent(first(keys.pct)),
    }
}

const DOCKER_STATS_KEYS: StatsKeys = StatsKeys {
    id: &["ID"],
    cpu: &["CPUPerc"],
    mem: &["MemUsage"],
    pct: &["MemPerc"],
};

const PODMAN_STATS_KEYS: StatsKeys = StatsKeys {
    id: &["id", "ID"],
    cpu: &["cpu_percent", "CPU", "cpu"],
    mem: &["mem_usage", "MemUsage"],
    pct: &["mem_percent", "MemPerc"],
};

/// Parses `docker stats --no-stream --format json`: one JSON object per line.
pub fn parse_docker_stats(text: &str) -> Vec<ContainerStats> {
    json_lines(text)
        .map(|v| stats_from(Engine::Docker, &v, &DOCKER_STATS_KEYS))
        .collect()
}

/// Parses `podman stats --no-stream --format json`: one JSON array.
pub fn parse_podman_stats(text: &str) -> Vec<ContainerStats> {
    json_array_objects(text)
        .iter()
        .map(|v| stats_from(Engine::Podman, v, &PODMAN_STATS_KEYS))
        .collect()
}

const ENGINES: [Engine; 2] = [Engine::Docker, Engine::Podman];
const CHANGE_DEBOUNCE: Duration = Duration::from_millis(300);
const RETRY_INTERVAL: Duration = Duration::from_secs(10);
/// Delay before re-listing after a `ps` failure on an engine believed to be running.
const SNAPSHOT_RETRY: Duration = Duration::from_secs(3);
/// A CLI whose daemon is starting or wedged can hang on `version`; detection must not stall.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a command waits for startup detection before answering with what it has.
const DETECTION_WAIT: Duration = Duration::from_secs(20);

impl Engine {
    fn label(self) -> &'static str {
        match self {
            Engine::Docker => "Docker",
            Engine::Podman => "Podman",
        }
    }

    fn exe_name(self) -> String {
        if cfg!(windows) {
            format!("{}.exe", self.cli())
        } else {
            self.cli().to_string()
        }
    }
}

fn find_in(path_var: &std::ffi::OsStr, exe: &str) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

fn locate(engine: Engine) -> Option<PathBuf> {
    find_in(&std::env::var_os("PATH")?, &engine.exe_name())
}

fn command(cli: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(cli);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    cmd
}

fn exec(cli: &Path, args: &[&str]) -> Result<String, String> {
    let out = command(cli, args)
        .output()
        .map_err(|e| format!("{}: {e}", cli.display()))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() {
        format!("{} exited with {}", cli.display(), out.status)
    } else {
        err
    })
}

/// Docker exits non-zero and prints a null `Server` when its daemon is down; Podman exits
/// non-zero when its machine is stopped. Unparseable output from a successful run counts as
/// running, so a format change does not hide a working engine.
fn version_says_running(success: bool, stdout: &str) -> bool {
    success
        && match serde_json::from_str::<Value>(stdout.trim()) {
            Ok(v) => !v.get("Server").is_some_and(Value::is_null),
            Err(_) => true,
        }
}

/// Whether the engine behind `cli` answers `version`.
fn probe(cli: &Path) -> bool {
    let mut cmd = command(cli, &["version", "--format", "json"]);
    cmd.stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut out) = stdout {
            let _ = out.read_to_end(&mut bytes);
        }
        let _ = tx.send(bytes);
    });
    let Ok(bytes) = rx.recv_timeout(PROBE_TIMEOUT) else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };
    let success = child.wait().is_ok_and(|s| s.success());
    version_says_running(success, &String::from_utf8_lossy(&bytes))
}

fn parse_action(action: &str) -> Result<&'static str, String> {
    match action {
        "start" => Ok("start"),
        "stop" => Ok("stop"),
        "restart" => Ok("restart"),
        other => Err(format!("unknown container action: {other}")),
    }
}

fn check_ids(ids: &[String]) -> Result<(), String> {
    match ids.iter().find(|id| id.is_empty() || id.starts_with('-')) {
        Some(id) => Err(format!("invalid container id: {id:?}")),
        None => Ok(()),
    }
}

fn with_ids<'a>(args: &[&'a str], ids: &'a [String]) -> Vec<&'a str> {
    args.iter()
        .copied()
        .chain(std::iter::once("--"))
        .chain(ids.iter().map(String::as_str))
        .collect()
}

fn list_engine(engine: Engine, cli: &Path) -> Result<Vec<Container>, String> {
    let text = exec(cli, &["ps", "-a", "--format", "json"])?;
    Ok(match engine {
        Engine::Docker => parse_docker_ps(&text),
        Engine::Podman => parse_podman_ps(&text),
    })
}

fn stats_engine(engine: Engine, cli: &Path, ids: &[String]) -> Result<Vec<ContainerStats>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    check_ids(ids)?;
    let text = exec(
        cli,
        &with_ids(&["stats", "--no-stream", "--format", "json"], ids),
    )?;
    Ok(match engine {
        Engine::Docker => parse_docker_stats(&text),
        Engine::Podman => parse_podman_stats(&text),
    })
}

fn action_engine(cli: &Path, ids: &[String], verb: &str) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    check_ids(ids)?;
    exec(cli, &with_ids(&[verb], ids)).map(|_| ())
}

/// Trailing-edge debounce: each poke pushes the deadline out by the window, and `fire` reports
/// once after the deadline passes.
#[derive(Debug)]
struct Debounce {
    window: Duration,
    deadline: Option<Instant>,
}

impl Debounce {
    fn new(window: Duration) -> Self {
        Self {
            window,
            deadline: None,
        }
    }

    fn poke(&mut self, now: Instant) {
        self.deadline = Some(now + self.window);
    }

    /// Schedules a fire after `delay` instead of the window.
    fn poke_after(&mut self, now: Instant, delay: Duration) {
        self.deadline = Some(now + delay);
    }

    /// Time left before the pending deadline, or None when nothing is pending.
    fn remaining(&self, now: Instant) -> Option<Duration> {
        self.deadline.map(|d| d.saturating_duration_since(now))
    }

    fn fire(&mut self, now: Instant) -> bool {
        if self.deadline.is_some_and(|d| now >= d) {
            self.deadline = None;
            return true;
        }
        false
    }
}

/// Container event actions that leave `ps` output as it was. A container shell produces
/// `exec_*`, `attach`, and `resize` events that would otherwise refresh the list for nothing.
const QUIET_ACTIONS: &[&str] = &[
    "attach",
    "detach",
    "resize",
    "top",
    "export",
    "commit",
    "copy",
    "archive-path",
    "extract-to-dir",
    "mount",
    "unmount",
    "sync",
    "checkpoint",
    "cleanup",
    "init",
];

/// Whether an `events --format json` line can change the list. Docker names the action
/// `Action`, Podman `Status`; a line that is not JSON counts, so a format change over-refreshes
/// rather than going stale.
fn event_changes_list(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return false;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return true;
    };
    let action = text(&v, &["Action", "Status", "status"]).to_ascii_lowercase();
    !(action.starts_with("exec_") || QUIET_ACTIONS.contains(&action.as_str()))
}

#[derive(Debug, Clone)]
struct Slot {
    engine: Engine,
    cli: PathBuf,
    running: bool,
}

#[derive(Default)]
struct Inner {
    /// None until startup detection finishes; an engine with no CLI has no slot.
    engines: Mutex<Option<Vec<Slot>>>,
    detected: Condvar,
    logs: Mutex<HashMap<u32, Child>>,
    next_stream: AtomicU32,
    events: Mutex<HashMap<Engine, Child>>,
    stopping: AtomicBool,
}

/// Detected engines, their running flags, and the live `logs` and `events` children.
#[derive(Default)]
pub struct ContainersState(Arc<Inner>);

impl Inner {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    fn slots(&self) -> Vec<Slot> {
        let guard = self.engines.lock().unwrap();
        let (guard, _) = self
            .detected
            .wait_timeout_while(guard, DETECTION_WAIT, |e| e.is_none())
            .unwrap();
        guard.clone().unwrap_or_default()
    }

    fn cli(&self, engine: Engine) -> Result<PathBuf, String> {
        self.slots()
            .into_iter()
            .find(|s| s.engine == engine)
            .map(|s| s.cli)
            .ok_or_else(|| format!("{} is not available", engine.label()))
    }

    /// Records an engine's running flag; true when it changed.
    fn set_running(&self, engine: Engine, running: bool) -> bool {
        let mut guard = self.engines.lock().unwrap();
        match guard.iter_mut().flatten().find(|s| s.engine == engine) {
            Some(slot) if slot.running != running => {
                slot.running = running;
                true
            }
            _ => false,
        }
    }

    /// The list from every running engine. An engine whose `ps` fails is reported not running
    /// in this snapshot; its watcher still owns the stored flag.
    fn snapshot(&self) -> ContainersSnapshot {
        self.snapshot_checked().0
    }

    /// Like `snapshot`, plus whether a `ps` failed on an engine whose stored flag says running:
    /// nothing else will refresh that engine's state, so the caller should list again soon.
    fn snapshot_checked(&self) -> (ContainersSnapshot, bool) {
        let mut failed = false;
        let mut engines = Vec::new();
        let mut containers = Vec::new();
        for slot in self.slots() {
            let listed = if slot.running {
                list_engine(slot.engine, &slot.cli)
                    .inspect_err(|e| eprintln!("{} ps failed: {e}", slot.engine.cli()))
                    .ok()
            } else {
                None
            };
            failed |= slot.running && listed.is_none();
            engines.push(EngineState {
                engine: slot.engine,
                running: listed.is_some(),
            });
            containers.extend(listed.into_iter().flatten());
        }
        (
            ContainersSnapshot {
                engines,
                containers,
            },
            failed,
        )
    }

    /// Sleeps up to `total`; false once shutdown begins.
    fn sleep(&self, total: Duration) -> bool {
        let end = Instant::now() + total;
        loop {
            if self.stopping() {
                return false;
            }
            let now = Instant::now();
            if now >= end {
                return true;
            }
            thread::sleep((end - now).min(Duration::from_millis(250)));
        }
    }

    fn end_logs(&self, stream_id: u32) {
        let child = self.logs.lock().unwrap().remove(&stream_id);
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Detects the engines and starts their watchers on a background thread.
pub fn init(app: &AppHandle) {
    let inner = app.state::<ContainersState>().0.clone();
    let app = app.clone();
    thread::spawn(move || {
        let slots: Vec<Slot> = ENGINES
            .iter()
            .filter_map(|&engine| {
                let cli = locate(engine)?;
                let running = probe(&cli);
                Some(Slot {
                    engine,
                    cli,
                    running,
                })
            })
            .collect();
        *inner.engines.lock().unwrap() = Some(slots.clone());
        inner.detected.notify_all();
        let (tx, rx) = mpsc::channel();
        for slot in slots {
            let inner = inner.clone();
            let tx = tx.clone();
            thread::spawn(move || watch_engine(&inner, slot, &tx));
        }
        drop(tx);
        notify_loop(&inner, &app, &rx);
    });
}

/// Emits a fresh snapshot once changes settle; ends when every watcher has.
fn notify_loop(inner: &Inner, app: &AppHandle, changes: &mpsc::Receiver<()>) {
    let mut debounce = Debounce::new(CHANGE_DEBOUNCE);
    loop {
        let got = match debounce.remaining(Instant::now()) {
            None => changes
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
            Some(left) => changes.recv_timeout(left),
        };
        match got {
            Ok(()) => debounce.poke(Instant::now()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if inner.stopping() {
            return;
        }
        if debounce.fire(Instant::now()) {
            let (snapshot, ps_failed) = inner.snapshot_checked();
            if app.emit("containers://changed", snapshot).is_err() {
                return;
            }
            // The single debounce deadline keeps retries from stacking; a change event in the
            // meantime only pulls the next snapshot earlier.
            if ps_failed {
                debounce.poke_after(Instant::now(), SNAPSHOT_RETRY);
            }
        }
    }
}

/// Follows one engine's events while it runs, and re-probes it every RETRY_INTERVAL while it
/// does not.
fn watch_engine(inner: &Inner, slot: Slot, changed: &mpsc::Sender<()>) {
    let mut running = slot.running;
    loop {
        if running {
            if inner.set_running(slot.engine, true) {
                let _ = changed.send(());
            }
            follow_events(inner, &slot, changed);
            if inner.stopping() {
                return;
            }
            inner.set_running(slot.engine, false);
            let _ = changed.send(());
        }
        if !inner.sleep(RETRY_INTERVAL) {
            return;
        }
        running = probe(&slot.cli);
    }
}

/// Runs the engine's `events` child until it exits or is killed.
fn follow_events(inner: &Inner, slot: &Slot, changed: &mpsc::Sender<()>) {
    let mut cmd = command(
        &slot.cli,
        &["events", "--filter", "type=container", "--format", "json"],
    );
    cmd.stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{} events failed to start: {e}", slot.engine.cli());
            return;
        }
    };
    let stdout = child.stdout.take();
    {
        let mut events = inner.events.lock().unwrap();
        // Checked under the lock so a shutdown that has already drained the map cannot miss
        // this child.
        if inner.stopping() || stdout.is_none() {
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        events.insert(slot.engine, child);
    }
    for line in BufReader::new(stdout.unwrap()).split(b'\n') {
        let Ok(line) = line else {
            break;
        };
        if event_changes_list(&String::from_utf8_lossy(&line)) && changed.send(()).is_err() {
            break;
        }
    }
    let child = inner.events.lock().unwrap().remove(&slot.engine);
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Kills every `logs` and `events` child: Windows does not end a child when its parent exits.
pub fn shutdown(app: &AppHandle) {
    let inner = &app.state::<ContainersState>().0;
    inner.stopping.store(true, Ordering::SeqCst);
    let events: Vec<Child> = inner
        .events
        .lock()
        .unwrap()
        .drain()
        .map(|(_, c)| c)
        .collect();
    let logs: Vec<Child> = inner.logs.lock().unwrap().drain().map(|(_, c)| c).collect();
    for mut child in events.into_iter().chain(logs) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Copies a pipe to the page until the pipe closes; when the page stops listening, ends the
/// stream so the child does not run on unread.
fn pump(mut pipe: impl Read, on_data: &Channel<InvokeResponseBody>, inner: &Inner, id: u32) {
    let mut buf = [0u8; 8192];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if on_data
                    .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                    .is_err()
                {
                    inner.end_logs(id);
                    return;
                }
            }
        }
    }
}

fn start_logs(
    inner: &Arc<Inner>,
    engine: Engine,
    id: String,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let cli = inner.cli(engine)?;
    let ids = [id];
    check_ids(&ids)?;
    let mut child = command(&cli, &with_ids(&["logs", "-f", "--tail", "500"], &ids))
        .spawn()
        .map_err(|e| format!("{}: {e}", cli.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stream_id = inner.next_stream.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut logs = inner.logs.lock().unwrap();
        if inner.stopping() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the app is closing".into());
        }
        logs.insert(stream_id, child);
    }
    let pipes: Vec<Box<dyn Read + Send>> = [
        stdout.map(|p| Box::new(p) as Box<dyn Read + Send>),
        stderr.map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    let pumps: Vec<_> = pipes
        .into_iter()
        .map(|pipe| {
            let (inner, on_data) = (inner.clone(), on_data.clone());
            thread::spawn(move || pump(pipe, &on_data, &inner, stream_id))
        })
        .collect();
    let inner = inner.clone();
    thread::spawn(move || {
        for p in pumps {
            let _ = p.join();
        }
        inner.end_logs(stream_id);
    });
    Ok(stream_id)
}

#[tauri::command]
pub async fn containers_list(
    state: State<'_, ContainersState>,
) -> Result<ContainersSnapshot, String> {
    let inner = state.0.clone();
    blocking(move || Ok(inner.snapshot())).await
}

#[tauri::command]
pub async fn containers_action(
    state: State<'_, ContainersState>,
    engine: Engine,
    ids: Vec<String>,
    action: String,
) -> Result<(), String> {
    let verb = parse_action(&action)?;
    let inner = state.0.clone();
    blocking(move || action_engine(&inner.cli(engine)?, &ids, verb)).await
}

#[tauri::command]
pub async fn containers_logs(
    state: State<'_, ContainersState>,
    engine: Engine,
    id: String,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let inner = state.0.clone();
    blocking(move || start_logs(&inner, engine, id, on_data)).await
}

#[tauri::command]
pub async fn containers_logs_stop(
    state: State<'_, ContainersState>,
    stream_id: u32,
) -> Result<(), String> {
    let inner = state.0.clone();
    blocking(move || {
        inner.end_logs(stream_id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn containers_stats(
    state: State<'_, ContainersState>,
    engine: Engine,
    ids: Vec<String>,
) -> Result<Vec<ContainerStats>, String> {
    let inner = state.0.clone();
    blocking(move || stats_engine(engine, &inner.cli(engine)?, &ids)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCKER_PS: &str = include_str!("../fixtures/containers/docker_ps.jsonl");
    const DOCKER_STATS: &str = include_str!("../fixtures/containers/docker_stats.jsonl");
    const PODMAN_PS: &str = include_str!("../fixtures/containers/podman_ps.json");
    const PODMAN_STATS: &str = include_str!("../fixtures/containers/podman_stats.json");

    fn by_name<'a>(list: &'a [Container], name: &str) -> &'a Container {
        list.iter().find(|c| c.name == name).expect(name)
    }

    fn tcp(host: u16, container: u16) -> Port {
        Port {
            host,
            container,
            protocol: "tcp".into(),
        }
    }

    #[test]
    fn docker_ps_fixture() {
        let list = parse_docker_ps(DOCKER_PS);
        assert_eq!(list.len(), 4);
        let web = by_name(&list, "bashboard-test-web");
        assert_eq!(web.engine, Engine::Docker);
        assert_eq!(web.id, "a9e523308c0d");
        assert_eq!(web.image, "nginx:alpine");
        assert_eq!(web.state, ContainerState::Running);
        assert_eq!(web.status_text, "Up 5 seconds");
        assert_eq!(web.project.as_deref(), Some("bashboard-test-proj"));
        assert_eq!(web.service.as_deref(), Some("web"));
        assert_eq!(web.ports, vec![tcp(18080, 80)]);
        assert_eq!(
            by_name(&list, "bashboard-test-made").state,
            ContainerState::Created
        );
    }

    #[test]
    fn docker_container_with_no_published_ports_or_compose_labels() {
        let list = parse_docker_ps(DOCKER_PS);
        let plain = by_name(&list, "bashboard-test-plain");
        assert!(plain.ports.is_empty());
        assert_eq!(plain.project, None);
        assert_eq!(plain.service, None);
        let cache = by_name(&list, "bashboard-test-cache");
        assert!(cache.ports.is_empty());
        assert_eq!(cache.service.as_deref(), Some("cache"));
    }

    #[test]
    fn docker_ports_dedupe_ipv4_and_ipv6() {
        let ports = docker_ports("0.0.0.0:8080->80/tcp, :::8080->80/tcp, [::]:8080->80/tcp");
        assert_eq!(ports, vec![tcp(8080, 80)]);
        let ports = docker_ports("0.0.0.0:53->53/udp, 0.0.0.0:53->53/tcp, 6379/tcp");
        assert_eq!(ports.len(), 2);
        assert_eq!(ports[0].protocol, "udp");
    }

    #[test]
    fn docker_port_ranges_expand_pairwise() {
        let ports = docker_ports("0.0.0.0:8000-8002->9000-9002/tcp");
        assert_eq!(ports.len(), 3);
        assert_eq!(ports[2], tcp(8002, 9002));
        assert!(docker_ports("0.0.0.0:8000-8002->9000/tcp").is_empty());
    }

    #[test]
    fn docker_malformed_line_is_skipped() {
        let good = DOCKER_PS.lines().next().unwrap();
        let text = format!("not json\n{{\"ID\":\"x\"\n{good}\n[1,2]\n\n");
        assert_eq!(parse_docker_ps(&text).len(), 1);
    }

    #[test]
    fn docker_missing_fields_degrade_the_row() {
        let list = parse_docker_ps("{\"ID\":\"abc\"}\n{\"Names\":\"n\",\"State\":\"removing\"}");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "abc");
        assert_eq!(list[0].name, "");
        assert_eq!(list[0].state, ContainerState::Unknown);
        assert_eq!(list[1].state, ContainerState::Unknown);
        assert!(list[1].ports.is_empty());
    }

    #[test]
    fn all_docker_states() {
        for (s, want) in [
            ("running", ContainerState::Running),
            ("paused", ContainerState::Paused),
            ("exited", ContainerState::Exited),
            ("created", ContainerState::Created),
            ("restarting", ContainerState::Restarting),
            ("dead", ContainerState::Dead),
            ("whatever", ContainerState::Unknown),
        ] {
            let line = format!("{{\"ID\":\"a\",\"State\":\"{s}\"}}");
            assert_eq!(parse_docker_ps(&line)[0].state, want, "{s}");
        }
    }

    #[test]
    fn podman_ps_fixture() {
        let list = parse_podman_ps(PODMAN_PS);
        assert_eq!(list.len(), 4);
        let web = by_name(&list, "myapp_web_1");
        assert_eq!(web.engine, Engine::Podman);
        assert_eq!(web.state, ContainerState::Running);
        assert_eq!(web.status_text, "Up 3 hours");
        assert_eq!(web.project.as_deref(), Some("myapp"));
        assert_eq!(web.service.as_deref(), Some("web"));
        assert_eq!(web.ports, vec![tcp(8080, 80)]);
        let range = by_name(&list, "ranged");
        assert_eq!(range.ports.len(), 3);
        assert_eq!(
            range.ports[2],
            Port {
                host: 9002,
                container: 7002,
                protocol: "udp".into()
            }
        );
        let plain = by_name(&list, "plain");
        assert!(plain.ports.is_empty());
        assert_eq!(plain.project, None);
        assert_eq!(by_name(&list, "stopped-one").state, ContainerState::Exited);
    }

    #[test]
    fn podman_prefers_docker_compose_labels_and_tolerates_garbage() {
        let text = r#"[{"Id":"1","Names":["a"],"Labels":{"com.docker.compose.project":"d","io.podman.compose.project":"p","io.podman.compose.service":"s"}}, 7, null, "x"]"#;
        let list = parse_podman_ps(text);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].project.as_deref(), Some("d"));
        assert_eq!(list[0].service.as_deref(), Some("s"));
        assert!(parse_podman_ps("not json").is_empty());
        assert!(parse_podman_ps("{}").is_empty());
        let nulls = parse_podman_ps(r#"[{"Id":"1","Names":null,"Ports":null,"Labels":null}]"#);
        assert!(nulls[0].name.is_empty());
    }

    #[test]
    fn docker_stats_fixture() {
        let stats = parse_docker_stats(DOCKER_STATS);
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].id, "a9e523308c0d");
        assert_eq!(stats[0].cpu_percent, Some(0.0));
        assert_eq!(stats[0].mem_usage.as_deref(), Some("17.21MiB / 7.756GiB"));
        assert_eq!(stats[0].mem_percent, Some(0.22));
        assert_eq!(stats[1].cpu_percent, Some(0.33));
    }

    #[test]
    fn podman_stats_fixture_accepts_text_and_numbers() {
        let stats = parse_podman_stats(PODMAN_STATS);
        assert_eq!(stats.len(), 3);
        assert_eq!(stats[0].engine, Engine::Podman);
        assert_eq!(stats[0].cpu_percent, Some(1.23));
        assert_eq!(stats[0].mem_usage.as_deref(), Some("12.5MB / 8.2GB"));
        assert_eq!(stats[0].mem_percent, Some(0.15));
        assert_eq!(stats[1].cpu_percent, Some(2.5));
        assert_eq!(stats[1].mem_percent, Some(0.4));
        assert_eq!(stats[2].cpu_percent, None);
        assert_eq!(stats[2].mem_usage, None);
    }

    #[test]
    fn stats_skip_malformed_input() {
        let one = parse_docker_stats("junk\n{\"ID\":\"a\",\"CPUPerc\":\"--\"}");
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].cpu_percent, None);
        assert!(parse_podman_stats("nope").is_empty());
    }

    #[test]
    fn serializes_camel_case() {
        let v = serde_json::to_value(&parse_docker_ps(DOCKER_PS)[0]).unwrap();
        assert!(v.get("statusText").is_some());
        assert_eq!(v["engine"], "docker");
        let s = serde_json::to_value(&parse_docker_stats(DOCKER_STATS)[0]).unwrap();
        assert!(s.get("cpuPercent").is_some() && s.get("memUsage").is_some());
    }

    #[test]
    fn debounce_poke_after_schedules_a_delayed_fire_that_a_change_pulls_earlier() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut d = Debounce::new(ms(300));
        d.poke_after(t0, ms(3000));
        assert!(!d.fire(t0 + ms(2999)));
        d.poke(t0 + ms(1000));
        assert!(d.fire(t0 + ms(1300)));
        assert!(!d.fire(t0 + ms(5000)));
    }

    #[test]
    fn debounce_fires_once_after_the_last_poke_settles() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut d = Debounce::new(ms(300));
        assert_eq!(d.remaining(t0), None);
        assert!(!d.fire(t0));
        d.poke(t0);
        d.poke(t0 + ms(200));
        assert_eq!(d.remaining(t0 + ms(250)), Some(ms(250)));
        assert!(!d.fire(t0 + ms(400)));
        assert!(d.fire(t0 + ms(500)));
        assert!(!d.fire(t0 + ms(900)));
        assert_eq!(d.remaining(t0 + ms(900)), None);
        d.poke(t0 + ms(1000));
        assert_eq!(d.remaining(t0 + ms(2000)), Some(Duration::ZERO));
        assert!(d.fire(t0 + ms(2000)));
    }

    #[test]
    fn unknown_actions_are_rejected() {
        assert_eq!(parse_action("start"), Ok("start"));
        assert_eq!(parse_action("stop"), Ok("stop"));
        assert_eq!(parse_action("restart"), Ok("restart"));
        for bad in ["rm", "kill", "", "Start", "start --force"] {
            assert!(
                parse_action(bad)
                    .unwrap_err()
                    .contains("unknown container action")
            );
        }
    }

    #[test]
    fn ids_follow_a_separator_and_flags_are_refused() {
        let ids = vec!["abc".to_string(), "def".to_string()];
        assert_eq!(with_ids(&["stop"], &ids), vec!["stop", "--", "abc", "def"]);
        assert!(check_ids(&ids).is_ok());
        assert!(check_ids(&["--rm".to_string()]).is_err());
        assert!(check_ids(&[String::new()]).is_err());
    }

    #[test]
    fn version_output_decides_running() {
        let up = r#"{"Client":{"Version":"29"},"Server":{"Version":"29"}}"#;
        let down = r#"{"Client":{"Version":"29"},"Server":null}"#;
        assert!(version_says_running(true, up));
        assert!(!version_says_running(true, down));
        assert!(!version_says_running(false, up));
        assert!(version_says_running(true, "not json"));
        assert!(version_says_running(true, r#"{"Client":{}}"#));
    }

    #[test]
    fn events_that_cannot_change_the_list_are_quiet() {
        let docker = |a: &str| format!(r#"{{"Type":"container","Action":"{a}","id":"x"}}"#);
        let podman = |s: &str| format!(r#"{{"Type":"container","Status":"{s}","ID":"x"}}"#);
        for a in [
            "start",
            "stop",
            "die",
            "destroy",
            "create",
            "rename",
            "health_status: healthy",
        ] {
            assert!(event_changes_list(&docker(a)), "{a}");
        }
        for s in ["start", "died", "remove", "pause"] {
            assert!(event_changes_list(&podman(s)), "{s}");
        }
        for a in [
            "exec_create: sh",
            "exec_start: sh -c x",
            "exec_die",
            "attach",
            "resize",
        ] {
            assert!(!event_changes_list(&docker(a)), "{a}");
        }
        assert!(!event_changes_list(&podman("cleanup")));
        assert!(!event_changes_list("  "));
        assert!(event_changes_list("container start abc (image=nginx)"));
    }

    #[test]
    fn finds_a_program_on_the_path() {
        let dir = std::env::temp_dir().join(format!("bashboard-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("docker.exe"), b"").unwrap();
        let path = std::env::join_paths([dir.join("missing"), dir.clone()]).unwrap();
        assert_eq!(find_in(&path, "docker.exe"), Some(dir.join("docker.exe")));
        assert_eq!(find_in(&path, "podman.exe"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Removes the throwaway container on drop, so a failed assertion still cleans up.
    struct Throwaway<'a> {
        cli: &'a Path,
        name: String,
    }

    impl Drop for Throwaway<'_> {
        fn drop(&mut self) {
            if self.name.starts_with("bashboard-test-") {
                let _ = exec(self.cli, &["rm", "-f", "--", &self.name]);
            }
        }
    }

    #[test]
    #[ignore = "needs Docker running and the redis:7-alpine image present"]
    fn live_docker_lists_acts_on_and_removes_a_throwaway_container() {
        let cli = locate(Engine::Docker).expect("docker on PATH");
        assert!(probe(&cli), "Docker is not running");
        let name = format!("bashboard-test-live-{}", std::process::id());
        assert!(name.starts_with("bashboard-test-"));
        let guard = Throwaway {
            cli: &cli,
            name: name.clone(),
        };
        exec(
            &cli,
            &[
                "run",
                "-d",
                "--pull",
                "never",
                "--name",
                &name,
                "redis:7-alpine",
            ],
        )
        .expect("docker run");
        let find = || {
            list_engine(Engine::Docker, &cli)
                .unwrap()
                .into_iter()
                .find(|c| c.name == name)
        };
        let c = find().expect("listed");
        assert_eq!(c.state, ContainerState::Running);
        assert_eq!(c.image, "redis:7-alpine");
        let ids = vec![c.id.clone()];
        let stats = stats_engine(Engine::Docker, &cli, &ids).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].id, c.id);
        action_engine(&cli, &ids, "stop").unwrap();
        assert_eq!(find().expect("still listed").state, ContainerState::Exited);
        drop(guard);
        assert!(find().is_none());
    }
}
