//! Session transcripts (design sections 3.3 and 3.4): finds each pane-bound agent session's
//! transcript (Claude Code's JSONL, a Codex rollout, or Copilot's `events.jsonl`), tails it for the
//! newest model and context size, and emits `agent://context` when any of them changes. Every
//! format is internal to its tool and undocumented, so every field is optional and an unreadable
//! line is skipped.

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        mpsc::{self, RecvTimeoutError, Sender},
    },
    thread,
    time::{Duration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::lock::LockExt;
use crate::agents::AgentId;
use crate::hooks::HookOverlay;
use crate::roster::Session;

mod codex;
mod copilot;

/// What a session file says about its newest state; every field is optional because the formats
/// are internal to each tool.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentReading {
    pub model: Option<String>,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
}

/// How much of a transcript's end is read first; transcripts grow to many megabytes.
const TAIL: u64 = 64 * 1024;
/// Lines parsed per batch when a non-Claude file is read whole.
const BATCH: usize = 4096;
const TICK: Duration = Duration::from_millis(250);
/// At most one read per second per session while appends stream in.
const READ_EVERY: Duration = Duration::from_secs(1);
/// Agents may create the transcript only after the first message.
const SEARCH_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContextReading {
    model: Option<String>,
    tokens: u64,
}

impl From<ContextReading> for AgentReading {
    fn from(r: ContextReading) -> Self {
        AgentReading {
            model: r.model,
            context_tokens: Some(r.tokens),
            context_window: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    pub session_id: String,
    pub model: Option<String>,
    pub context_tokens: Option<u64>,
    /// Null for Claude Code, whose transcript does not record the window.
    pub context_window: Option<u64>,
}

/// The newest assistant turn's context, or `None` when the line does not qualify: not an
/// assistant line, a subagent's turn (it would report the subagent's context), no usage, or a
/// `<synthetic>` notice Claude Code writes for local errors and interrupts.
fn qualifying(line: &str) -> Option<ContextReading> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "assistant" {
        return None;
    }
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let message = v.get("message")?;
    let usage = message.get("usage")?.as_object()?;
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if model.as_deref() == Some("<synthetic>") {
        return None;
    }
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    Some(ContextReading {
        model,
        tokens: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"),
    })
}

fn newest_in(text: &str) -> Option<ContextReading> {
    text.lines().rev().find_map(qualifying)
}

/// The last `TAIL` bytes as whole lines, and whether they are the whole file.
fn read_tail(file: &mut File) -> io::Result<(String, bool)> {
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)?;
    // Lossy, since the cut may split a UTF-8 sequence.
    let text = String::from_utf8_lossy(&bytes);
    let text = if start > 0 {
        // The first line is partial when the read starts mid-file.
        text.split_once('\n').map_or("", |(_, rest)| rest).to_owned()
    } else {
        text.into_owned()
    };
    Ok((text, start == 0))
}

/// Reads the last `TAIL` bytes, widening to a streamed pass over the whole file only when the
/// tail holds no qualifying line.
fn read_newest(path: &Path) -> io::Result<Option<ContextReading>> {
    let mut file = File::open(path)?;
    let (text, whole) = read_tail(&mut file)?;
    if let Some(reading) = newest_in(&text) {
        return Ok(Some(reading));
    }
    if whole {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut newest = None;
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if let Some(reading) = qualifying(&String::from_utf8_lossy(&line)) {
            newest = Some(reading);
        }
    }
    Ok(newest)
}

/// Folds a later batch's reading over an earlier one. Tokens and window travel together, since
/// they come from the same line.
fn merge(acc: &mut AgentReading, next: AgentReading) {
    if next.model.is_some() {
        acc.model = next.model;
    }
    if next.context_tokens.is_some() {
        acc.context_tokens = next.context_tokens;
        acc.context_window = next.context_window;
    }
}

type Parse = fn(&[&str]) -> AgentReading;

/// Parses the tail, widening to a batched pass over the whole file when the tail leaves the
/// reading incomplete (a long turn can push the model's line out of the tail).
fn read_with(
    path: &Path,
    parse: Parse,
    complete: fn(&AgentReading) -> bool,
) -> io::Result<AgentReading> {
    let mut file = File::open(path)?;
    let (text, whole) = read_tail(&mut file)?;
    let reading = parse(&text.lines().collect::<Vec<_>>());
    if whole || complete(&reading) {
        return Ok(reading);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut reader = BufReader::new(file);
    let mut out = AgentReading::default();
    let mut batch: Vec<String> = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n > 0 {
            batch.push(String::from_utf8_lossy(&line).trim_end().to_owned());
        }
        if batch.len() >= BATCH || (n == 0 && !batch.is_empty()) {
            merge(&mut out, parse(&batch.iter().map(String::as_str).collect::<Vec<_>>()));
            batch.clear();
        }
        if n == 0 {
            return Ok(out);
        }
    }
}

/// The newest reading of an agent's session file, or `None` when it says nothing yet.
fn read_session(agent: AgentId, path: &Path) -> io::Result<Option<AgentReading>> {
    let reading = match agent {
        AgentId::Claude => return Ok(read_newest(path)?.map(AgentReading::from)),
        AgentId::Codex => read_with(
            path,
            |lines| codex::newest_reading(lines.iter().copied()),
            |r| r.model.is_some() && r.context_tokens.is_some(),
        )?,
        AgentId::Copilot => read_copilot(path)?,
    };
    Ok((reading != AgentReading::default()).then_some(reading))
}

/// The live `events.jsonl`'s model, or, when the live file names none, the newest rotated archive's
/// that does.
fn read_copilot(path: &Path) -> io::Result<AgentReading> {
    let parse: Parse = |lines| copilot::newest_reading(lines.iter().copied());
    let complete: fn(&AgentReading) -> bool = |r| r.model.is_some();
    let live = read_with(path, parse, complete)?;
    if live.model.is_some() {
        return Ok(live);
    }
    for archive in copilot::archives_newest_first(path) {
        // A missing or unreadable archive must not hide a model in an older one.
        if let Ok(reading) = read_with(&archive, parse, complete) {
            if reading.model.is_some() {
                return Ok(reading);
            }
        }
    }
    Ok(live)
}

/// Whether a session id can be joined into a path or file name without escaping its folder.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && !id.contains(['/', '\\', ':']) && !id.contains("..")
}

/// The first `<projects>/*/<sessionId>.jsonl` that is a file.
fn find_by_session(projects: &Path, session_id: &str) -> Option<PathBuf> {
    if !safe_id(session_id) {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

/// Each agent's home folder, resolved once when the worker starts.
#[derive(Debug, Clone, Default)]
struct Homes {
    claude: Option<PathBuf>,
    codex: Option<PathBuf>,
    copilot: Option<PathBuf>,
}

impl Homes {
    fn detect() -> Self {
        Homes {
            claude: AgentId::Claude.agent().home(),
            codex: AgentId::Codex.agent().home(),
            copilot: AgentId::Copilot.agent().home(),
        }
    }
}

/// The session file found from the id alone, once it exists.
fn find_session(homes: &Homes, agent: AgentId, id: &str) -> Option<PathBuf> {
    if !safe_id(id) {
        return None;
    }
    match agent {
        AgentId::Claude => find_by_session(&homes.claude.as_ref()?.join("projects"), id),
        AgentId::Codex => codex::find_rollout(&homes.codex.as_ref()?.join("sessions"), id),
        AgentId::Copilot => {
            Some(copilot::events_path(homes.copilot.as_ref()?, id)).filter(|p| p.is_file())
        }
    }
}

/// The hook-reported transcript a session is read from. Copilot reports one only on `Stop`, so
/// its file always comes from the id; a compressed Codex rollout is never a live session's file.
fn hook_path(agent: AgentId, path: Option<&str>) -> Option<String> {
    let path = path.filter(|p| !p.is_empty())?;
    match agent {
        AgentId::Claude => Some(path.to_owned()),
        AgentId::Codex => (!path.to_ascii_lowercase().ends_with(".zst")).then(|| path.to_owned()),
        AgentId::Copilot => None,
    }
}

/// Watcher events and hook paths may differ in case and separators for the same file.
fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

#[derive(Debug, Default)]
struct Tracked {
    agent: AgentId,
    path: Option<PathBuf>,
    hook_path: Option<PathBuf>,
    last_read: Option<Instant>,
    dirty: bool,
    last_search: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    active: bool,
    tracked: HashMap<String, Tracked>,
    contexts: HashMap<String, AgentContext>,
}

/// One pane-bound session as `sync` sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SyncEntry {
    id: String,
    agent: AgentId,
    hook: Option<String>,
}

type SyncList = Vec<SyncEntry>;

enum Msg {
    Sync(SyncList),
    Fs(notify::Result<notify::Event>),
    Wake,
}

#[derive(Default)]
pub struct Transcripts {
    inner: Mutex<Inner>,
    tx: Mutex<Option<Sender<Msg>>>,
}

impl Transcripts {
    fn send(&self, msg: Msg) {
        if let Some(tx) = self.tx.lock_or_recover().as_ref() {
            let _ = tx.send(msg);
        }
    }

    pub fn prune(&self, live: &HashSet<&str>) {
        let mut inner = self.inner.lock_or_recover();
        inner.tracked.retain(|id, _| live.contains(id.as_str()));
        inner.contexts.retain(|id, _| live.contains(id.as_str()));
    }
}

/// Starts tracking on the first call, so a user with the Panes section off pays nothing, and
/// returns every known context so a page reload shows them at once.
#[tauri::command]
pub fn agent_context(state: State<'_, Transcripts>) -> Vec<AgentContext> {
    let (woke, mut out) = {
        let mut inner = state.inner.lock_or_recover();
        let woke = !inner.active;
        inner.active = true;
        (woke, inner.contexts.values().cloned().collect::<Vec<_>>())
    };
    if woke {
        state.send(Msg::Wake);
    }
    out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    out
}

/// Stops tracking and forgets every session, so a disabled Panes section costs nothing; the next
/// `agent_context` starts it again.
#[tauri::command]
pub fn agent_context_stop(state: State<'_, Transcripts>) {
    let mut inner = state.inner.lock_or_recover();
    inner.active = false;
    inner.tracked.clear();
    inner.contexts.clear();
}

fn sync_list(sessions: &[Session], overlay: &HashMap<String, HookOverlay>) -> SyncList {
    sessions
        .iter()
        .filter(|s| s.pane_id.is_some())
        .map(|s| {
            let hook = overlay
                .get(&s.session_id)
                .and_then(|o| hook_path(s.agent, o.transcript_path.as_deref()));
            SyncEntry {
                id: s.session_id.clone(),
                agent: s.agent,
                hook,
            }
        })
        .collect()
}

/// Hands the pane-bound sessions to the worker; never touches files.
pub fn sync(app: &AppHandle, sessions: &[Session], overlay: &HashMap<String, HookOverlay>) {
    app.state::<Transcripts>()
        .send(Msg::Sync(sync_list(sessions, overlay)));
}

/// Adds listed sessions, drops unlisted ones with their contexts, and switches a session whose
/// hook reports a different transcript to that file.
fn apply_sync(inner: &mut Inner, list: SyncList) {
    let listed: HashSet<&str> = list.iter().map(|e| e.id.as_str()).collect();
    inner.tracked.retain(|id, _| listed.contains(id.as_str()));
    inner.contexts.retain(|id, _| listed.contains(id.as_str()));
    for SyncEntry { id, agent, hook } in list {
        let hook = hook.filter(|h| !h.is_empty()).map(PathBuf::from);
        let t = inner.tracked.entry(id).or_insert_with(|| Tracked {
            agent,
            ..Tracked::default()
        });
        if t.agent != agent {
            *t = Tracked {
                agent,
                ..Tracked::default()
            };
        }
        if hook.is_some() && t.hook_path != hook {
            t.path = hook.clone();
            t.hook_path = hook;
            t.dirty = true;
            t.last_read = None;
        }
    }
}

fn mark_dirty(inner: &mut Inner, event: &notify::Event) {
    let keys: HashSet<String> = event.paths.iter().map(|p| path_key(p)).collect();
    for t in inner.tracked.values_mut() {
        if t.path
            .as_deref()
            .is_some_and(|p| keys.contains(&path_key(p)))
        {
            t.dirty = true;
        }
    }
}

struct Worker {
    app: AppHandle,
    homes: Homes,
    pending: Option<SyncList>,
    watcher: Option<RecommendedWatcher>,
    watched: HashMap<String, PathBuf>,
    fs_tx: Sender<Msg>,
}

impl Worker {
    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Sync(list) => self.pending = Some(list),
            Msg::Fs(Ok(event)) => mark_dirty(
                &mut self.app.state::<Transcripts>().inner.lock_or_recover(),
                &event,
            ),
            Msg::Fs(Err(_)) | Msg::Wake => {}
        }
    }

    fn tick(&mut self, now: Instant) {
        let app = self.app.clone();
        let state = app.state::<Transcripts>();
        let to_search: Vec<(String, AgentId)> = {
            let mut inner = state.inner.lock_or_recover();
            if !inner.active {
                drop(inner);
                // Release the file watches a stopped tracker left behind.
                if !self.watched.is_empty() {
                    self.update_watches(HashMap::new());
                }
                return;
            }
            if let Some(list) = self.pending.take() {
                apply_sync(&mut inner, list);
            }
            inner
                .tracked
                .iter_mut()
                .filter(|(_, t)| t.path.is_none())
                .filter(|(_, t)| {
                    t.last_search
                        .is_none_or(|at| now.duration_since(at) >= SEARCH_EVERY)
                })
                .map(|(id, t)| {
                    t.last_search = Some(now);
                    (id.clone(), t.agent)
                })
                .collect()
        };
        let found: Vec<(String, PathBuf)> = to_search
            .into_iter()
            .filter_map(|(id, agent)| find_session(&self.homes, agent, &id).map(|p| (id, p)))
            .collect();

        let (to_read, wanted) = {
            let mut inner = state.inner.lock_or_recover();
            for (id, path) in found {
                if let Some(t) = inner.tracked.get_mut(&id).filter(|t| t.path.is_none()) {
                    t.path = Some(path);
                    t.dirty = true;
                }
            }
            let wanted: HashMap<String, PathBuf> = inner
                .tracked
                .values()
                .filter_map(|t| t.path.clone())
                .map(|p| (path_key(&p), p))
                .collect();
            let to_read: Vec<(String, AgentId, PathBuf)> = inner
                .tracked
                .iter_mut()
                .filter(|(_, t)| {
                    t.dirty
                        && t.last_read
                            .is_none_or(|at| now.duration_since(at) >= READ_EVERY)
                })
                .filter_map(|(id, t)| {
                    let path = t.path.clone()?;
                    t.dirty = false;
                    t.last_read = Some(now);
                    Some((id.clone(), t.agent, path))
                })
                .collect();
            (to_read, wanted)
        };

        self.update_watches(wanted);

        let readings: Vec<(String, AgentReading)> = to_read
            .into_iter()
            .filter_map(|(id, agent, path)| {
                read_session(agent, &path).ok().flatten().map(|r| (id, r))
            })
            .collect();
        if readings.is_empty() {
            return;
        }
        let changed: Vec<AgentContext> = {
            let mut inner = state.inner.lock_or_recover();
            let inner = &mut *inner;
            let mut changed = Vec::new();
            for (id, r) in readings {
                if !inner.tracked.contains_key(&id) {
                    continue;
                }
                let next = AgentContext {
                    session_id: id.clone(),
                    model: r.model,
                    context_tokens: r.context_tokens,
                    context_window: r.context_window,
                };
                if inner.contexts.get(&id) != Some(&next) {
                    inner.contexts.insert(id, next.clone());
                    changed.push(next);
                }
            }
            changed
        };
        for ctx in changed {
            let _ = app.emit("agent://context", ctx);
        }
    }

    /// Watches each session file on its own (non-recursively), never a whole agent home.
    fn update_watches(&mut self, wanted: HashMap<String, PathBuf>) {
        if self.watcher.is_none() && !wanted.is_empty() {
            let tx = self.fs_tx.clone();
            match notify::recommended_watcher(move |ev| {
                let _ = tx.send(Msg::Fs(ev));
            }) {
                Ok(w) => self.watcher = Some(w),
                Err(e) => {
                    eprintln!("transcript: no watcher: {e}");
                    return;
                }
            }
        }
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
        self.watched.retain(|key, path| {
            let keep = wanted.contains_key(key);
            if !keep {
                let _ = watcher.unwatch(path);
            }
            keep
        });
        for (key, path) in wanted {
            if !self.watched.contains_key(&key)
                && watcher.watch(&path, RecursiveMode::NonRecursive).is_ok()
            {
                self.watched.insert(key, path);
            }
        }
    }
}

/// Starts the worker thread. Nothing is tracked until `agent_context` first runs.
pub fn init(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<Msg>();
    *app.state::<Transcripts>().tx.lock_or_recover() = Some(tx.clone());
    let mut worker = Worker {
        app: app.clone(),
        homes: Homes::detect(),
        pending: None,
        watcher: None,
        watched: HashMap::new(),
        fs_tx: tx,
    };
    thread::spawn(move || {
        loop {
            match rx.recv_timeout(TICK) {
                Ok(msg) => {
                    worker.handle(msg);
                    while let Ok(msg) = rx.try_recv() {
                        worker.handle(msg);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            worker.tick(Instant::now());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bashboard-transcript-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn assistant(model: &str, input: u64, creation: u64, read: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":false,"message":{{"model":"{model}","usage":{{"input_tokens":{input},"cache_creation_input_tokens":{creation},"cache_read_input_tokens":{read},"output_tokens":9}}}}}}"#
        )
    }

    fn reading(model: &str, tokens: u64) -> Option<ContextReading> {
        Some(ContextReading {
            model: Some(model.into()),
            tokens,
        })
    }

    #[test]
    fn qualifying_lines() {
        assert_eq!(
            qualifying(&assistant("claude-opus-5-5", 1, 20, 300)),
            reading("claude-opus-5-5", 321)
        );
        let sidechain =
            assistant("m", 1, 1, 1).replace(r#""isSidechain":false"#, r#""isSidechain":true"#);
        assert_eq!(qualifying(&sidechain), None);
        assert_eq!(
            qualifying(r#"{"type":"assistant","message":{"model":"m"}}"#),
            None
        );
        assert_eq!(
            qualifying(r#"{"type":"user","message":{"usage":{"input_tokens":5}}}"#),
            None
        );
        assert_eq!(qualifying(&assistant("<synthetic>", 0, 0, 0)), None);
        assert_eq!(qualifying("{ not json"), None);
        assert_eq!(qualifying(""), None);
    }

    #[test]
    fn tokens_sum_with_a_field_absent() {
        let line = r#"{"type":"assistant","message":{"model":"m","usage":{"input_tokens":7,"cache_read_input_tokens":100}}}"#;
        assert_eq!(qualifying(line), reading("m", 107));
        let no_model = r#"{"type":"assistant","message":{"usage":{"input_tokens":3}}}"#;
        assert_eq!(
            qualifying(no_model),
            Some(ContextReading {
                model: None,
                tokens: 3
            })
        );
    }

    #[test]
    fn newest_qualifying_line_wins() {
        let text = [
            assistant("old", 1, 0, 0),
            assistant("new", 2, 0, 0),
            "{ bad line".into(),
            assistant("m", 1, 1, 1).replace(r#""isSidechain":false"#, r#""isSidechain":true"#),
            r#"{"type":"user"}"#.into(),
        ]
        .join("\n");
        assert_eq!(newest_in(&text), reading("new", 2));
    }

    #[test]
    fn small_file_reads_whole() {
        let dir = temp_dir("small");
        let path = dir.join("s.jsonl");
        fs::write(
            &path,
            format!(
                "{}\r\n{}\r\n",
                assistant("a", 1, 0, 0),
                assistant("b", 2, 0, 0)
            ),
        )
        .unwrap();
        assert_eq!(read_newest(&path).unwrap(), reading("b", 2));
        fs::write(&path, r#"{"type":"user"}"#).unwrap();
        assert_eq!(read_newest(&path).unwrap(), None);
        assert!(read_newest(&dir.join("missing.jsonl")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// A user line padded to about `bytes`.
    fn filler(bytes: usize) -> String {
        format!(r#"{{"type":"user","text":"{}"}}"#, "x".repeat(bytes))
    }

    #[test]
    fn tail_without_assistant_widens_to_whole_file() {
        let dir = temp_dir("widen");
        let path = dir.join("w.jsonl");
        let mut f = File::create(&path).unwrap();
        writeln!(f, "{}", assistant("early", 5, 0, 0)).unwrap();
        for _ in 0..40 {
            writeln!(f, "{}", filler(4000)).unwrap();
        }
        drop(f);
        assert!(fs::metadata(&path).unwrap().len() > TAIL * 2);
        assert_eq!(read_newest(&path).unwrap(), reading("early", 5));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn line_straddling_the_cut_is_not_misparsed() {
        let dir = temp_dir("straddle");
        let path = dir.join("c.jsonl");
        let straddler = assistant("straddler", 200, 0, 0);
        // Size what follows the straddler so the 64 KiB cut lands in its middle.
        let target = TAIL as usize - straddler.len() / 2;
        let after = format!("{}\n", filler(target - filler(0).len() - 1));
        let mut f = File::create(&path).unwrap();
        writeln!(f, "{}", assistant("early", 100, 0, 0)).unwrap();
        writeln!(f, "{}", filler(100_000)).unwrap();
        let cut_from_end = TAIL as usize;
        let tail_of_straddler = cut_from_end - after.len();
        assert!(tail_of_straddler > 0 && tail_of_straddler < straddler.len());
        writeln!(f, "{straddler}").unwrap();
        write!(f, "{after}").unwrap();
        drop(f);
        assert_eq!(read_newest(&path).unwrap(), reading("straddler", 200));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lossy_decode_survives_a_split_utf8_sequence() {
        let dir = temp_dir("utf8");
        let path = dir.join("u.jsonl");
        let mut f = File::create(&path).unwrap();
        writeln!(
            f,
            "{}",
            format!(r#"{{"type":"user","text":"{}"}}"#, "\u{e9}".repeat(40_000))
        )
        .unwrap();
        writeln!(f, "{}", assistant("m", 9, 0, 0)).unwrap();
        drop(f);
        assert_eq!(read_newest(&path).unwrap(), reading("m", 9));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fallback_search_finds_any_project_folder() {
        let projects = temp_dir("projects");
        fs::create_dir_all(projects.join("C--a")).unwrap();
        fs::create_dir_all(projects.join("C--b")).unwrap();
        fs::write(projects.join("C--b").join("abc-123.jsonl"), "").unwrap();
        assert_eq!(
            find_by_session(&projects, "abc-123"),
            Some(projects.join("C--b").join("abc-123.jsonl"))
        );
        assert_eq!(find_by_session(&projects, "missing"), None);
        assert_eq!(find_by_session(&projects, "..\\C--b\\abc-123"), None);
        assert_eq!(find_by_session(&projects.join("nope"), "abc-123"), None);
        let _ = fs::remove_dir_all(&projects);
    }

    fn ctx(id: &str) -> AgentContext {
        AgentContext {
            session_id: id.into(),
            model: Some("m".into()),
            context_tokens: Some(1),
            context_window: None,
        }
    }

    fn entry(id: &str, hook: Option<&str>) -> SyncEntry {
        SyncEntry {
            id: id.into(),
            agent: AgentId::Claude,
            hook: hook.map(str::to_owned),
        }
    }

    #[test]
    fn prune_drops_non_live_sessions() {
        let t = Transcripts::default();
        {
            let mut inner = t.inner.lock_or_recover();
            for id in ["live", "gone"] {
                inner.tracked.insert(id.into(), Tracked::default());
                inner.contexts.insert(id.into(), ctx(id));
            }
        }
        t.prune(&HashSet::from(["live"]));
        let inner = t.inner.lock_or_recover();
        assert_eq!(inner.tracked.keys().collect::<Vec<_>>(), ["live"]);
        assert_eq!(inner.contexts.keys().collect::<Vec<_>>(), ["live"]);
    }

    #[test]
    fn sync_adds_drops_and_switches_hook_paths() {
        let mut inner = Inner::default();
        apply_sync(
            &mut inner,
            vec![
                entry("a", None),
                entry("b", Some("C:\\b1.jsonl")),
            ],
        );
        inner.contexts.insert("a".into(), ctx("a"));
        let b = &inner.tracked["b"];
        assert_eq!(
            (b.path.as_deref(), b.dirty),
            (Some(Path::new("C:\\b1.jsonl")), true)
        );
        assert_eq!(inner.tracked["a"].path, None);

        // A found path survives a sync without a hook path; a new hook path replaces it.
        inner.tracked.get_mut("a").unwrap().path = Some("C:\\found.jsonl".into());
        inner.tracked.get_mut("b").unwrap().dirty = false;
        apply_sync(
            &mut inner,
            vec![
                entry("a", None),
                entry("b", Some("C:\\b1.jsonl")),
            ],
        );
        assert_eq!(
            inner.tracked["a"].path.as_deref(),
            Some(Path::new("C:\\found.jsonl"))
        );
        assert!(!inner.tracked["b"].dirty);
        apply_sync(
            &mut inner,
            vec![
                entry("a", None),
                entry("b", Some("C:\\b2.jsonl")),
            ],
        );
        assert_eq!(
            inner.tracked["b"].path.as_deref(),
            Some(Path::new("C:\\b2.jsonl"))
        );
        assert!(inner.tracked["b"].dirty);

        apply_sync(&mut inner, vec![entry("b", None)]);
        assert!(!inner.tracked.contains_key("a"));
        assert!(!inner.contexts.contains_key("a"));
        assert_eq!(
            inner.tracked["b"].path.as_deref(),
            Some(Path::new("C:\\b2.jsonl"))
        );
    }

    #[test]
    fn events_mark_matching_sessions_dirty() {
        let mut inner = Inner::default();
        apply_sync(
            &mut inner,
            vec![
                entry("a", Some("C:\\Users\\Me\\t.jsonl")),
                entry("b", None),
            ],
        );
        inner.tracked.get_mut("a").unwrap().dirty = false;
        let event = notify::Event::new(notify::EventKind::Any)
            .add_path(PathBuf::from("c:/users/me/T.jsonl"));
        mark_dirty(&mut inner, &event);
        assert!(inner.tracked["a"].dirty);
        assert!(!inner.tracked["b"].dirty);
    }

    fn session(id: &str, pane_id: Option<u32>, agent: AgentId) -> Session {
        Session {
            session_id: id.into(),
            pid: 1,
            name: None,
            cwd: String::new(),
            status: crate::roster::SessionStatus::Idle,
            raw_status: None,
            status_changed_at: 0,
            started_at: 0,
            version: None,
            pane_id,
            waiting_reason: None,
            permission_mode: None,
            agent,
        }
    }

    fn overlay_with(path: &str) -> HookOverlay {
        HookOverlay {
            transcript_path: Some(path.into()),
            ..Default::default()
        }
    }

    #[test]
    fn sync_list_keeps_pane_bound_sessions_with_hook_paths() {
        let sessions = [
            session("hooked", Some(1), AgentId::Claude),
            session("ancestry", Some(2), AgentId::Claude),
            session("external", None, AgentId::Claude),
            session("cx", Some(3), AgentId::Codex),
            session("cx-old", Some(4), AgentId::Codex),
            session("cp", Some(5), AgentId::Copilot),
        ];
        let overlay = HashMap::from([
            ("hooked".to_string(), overlay_with("C:\\t.jsonl")),
            ("external".to_string(), overlay_with("C:\\e.jsonl")),
            ("cx".to_string(), overlay_with("C:\\r.jsonl")),
            ("cx-old".to_string(), overlay_with("C:\\r.jsonl.ZST")),
            ("cp".to_string(), overlay_with("C:\\events.jsonl")),
        ]);
        let entry = |id: &str, agent, hook: Option<&str>| SyncEntry {
            id: id.into(),
            agent,
            hook: hook.map(str::to_owned),
        };
        assert_eq!(
            sync_list(&sessions, &overlay),
            vec![
                entry("hooked", AgentId::Claude, Some("C:\\t.jsonl")),
                entry("ancestry", AgentId::Claude, None),
                entry("cx", AgentId::Codex, Some("C:\\r.jsonl")),
                entry("cx-old", AgentId::Codex, None),
                entry("cp", AgentId::Copilot, None),
            ]
        );
    }

    #[test]
    fn sync_resets_a_session_whose_agent_changes() {
        let mut inner = Inner::default();
        apply_sync(&mut inner, vec![entry("a", Some("C:\\a.jsonl"))]);
        apply_sync(
            &mut inner,
            vec![SyncEntry {
                id: "a".into(),
                agent: AgentId::Codex,
                hook: None,
            }],
        );
        let a = &inner.tracked["a"];
        assert_eq!((a.agent, a.path.as_deref()), (AgentId::Codex, None));
    }

    /// A temp tree with one home folder per agent.
    fn homes(tag: &str) -> (PathBuf, Homes) {
        let root = temp_dir(tag);
        let homes = Homes {
            claude: Some(root.join(".claude")),
            codex: Some(root.join(".codex")),
            copilot: Some(root.join(".copilot")),
        };
        (root, homes)
    }

    #[test]
    fn find_session_per_agent() {
        let (root, homes) = homes("find");
        let id = "0199a213-81c0-7800-8aa1-bbab2a035a53";

        let claude = root.join(".claude").join("projects").join("C--x");
        fs::create_dir_all(&claude).unwrap();
        fs::write(claude.join(format!("{id}.jsonl")), "").unwrap();
        assert_eq!(
            find_session(&homes, AgentId::Claude, id),
            Some(claude.join(format!("{id}.jsonl")))
        );

        let day = root.join(".codex").join("sessions").join("2026").join("11").join("04");
        fs::create_dir_all(&day).unwrap();
        let rollout = day.join(format!("rollout-2026-11-04T09-00-00-{id}.jsonl"));
        fs::write(&rollout, "").unwrap();
        assert_eq!(find_session(&homes, AgentId::Codex, id), Some(rollout));

        let state = root.join(".copilot").join("session-state").join(id);
        assert_eq!(find_session(&homes, AgentId::Copilot, id), None);
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("events.jsonl"), "").unwrap();
        assert_eq!(
            find_session(&homes, AgentId::Copilot, id),
            Some(state.join("events.jsonl"))
        );

        // Each agent only looks in its own home.
        assert_eq!(find_session(&homes, AgentId::Claude, "other"), None);
        assert_eq!(find_session(&Homes::default(), AgentId::Copilot, id), None);
        for bad in ["", "..", "..\\x", "a/b", "C:x"] {
            for agent in AgentId::ALL {
                assert_eq!(find_session(&homes, agent, bad), None, "{bad:?}");
            }
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_session_parses_per_agent() {
        let dir = temp_dir("agents");
        let claude = dir.join("c.jsonl");
        fs::write(&claude, assistant("claude-opus-5-5", 1, 2, 3)).unwrap();
        assert_eq!(
            read_session(AgentId::Claude, &claude).unwrap(),
            Some(AgentReading {
                model: Some("claude-opus-5-5".into()),
                context_tokens: Some(6),
                context_window: None,
            })
        );

        let codex = dir.join("rollout.jsonl");
        fs::write(&codex, format!("{CODEX_TURN}\r\n{CODEX_COUNT}\r\n")).unwrap();
        assert_eq!(
            read_session(AgentId::Codex, &codex).unwrap(),
            Some(AgentReading {
                model: Some("gpt-5.5".into()),
                context_tokens: Some(420),
                context_window: Some(272000),
            })
        );

        let copilot = dir.join("events.jsonl");
        fs::write(&copilot, format!("{COPILOT_START}\n{COPILOT_CHANGE}\n")).unwrap();
        assert_eq!(
            read_session(AgentId::Copilot, &copilot).unwrap(),
            Some(AgentReading {
                model: Some("claude-sonnet-4.5".into()),
                ..AgentReading::default()
            })
        );

        fs::write(&copilot, r#"{"type":"user.message","data":{}}"#).unwrap();
        assert_eq!(read_session(AgentId::Copilot, &copilot).unwrap(), None);
        assert!(read_session(AgentId::Codex, &dir.join("missing.jsonl")).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_claude_tail_without_the_model_widens_to_whole_file() {
        let dir = temp_dir("agent-widen");
        let codex = dir.join("rollout.jsonl");
        let mut f = File::create(&codex).unwrap();
        writeln!(f, "{CODEX_TURN}").unwrap();
        for _ in 0..(BATCH + 10) {
            writeln!(f, "{}", filler(40)).unwrap();
        }
        writeln!(f, "{CODEX_COUNT}").unwrap();
        drop(f);
        assert!(fs::metadata(&codex).unwrap().len() > TAIL * 2);
        let r = read_session(AgentId::Codex, &codex).unwrap().unwrap();
        assert_eq!(
            (r.model.as_deref(), r.context_tokens),
            (Some("gpt-5.5"), Some(420))
        );

        let copilot = dir.join("events.jsonl");
        let mut f = File::create(&copilot).unwrap();
        writeln!(f, "{COPILOT_START}").unwrap();
        writeln!(f, "{COPILOT_CHANGE}").unwrap();
        for _ in 0..(BATCH + 10) {
            writeln!(f, "{}", filler(40)).unwrap();
        }
        drop(f);
        let r = read_session(AgentId::Copilot, &copilot).unwrap().unwrap();
        assert_eq!(r.model.as_deref(), Some("claude-sonnet-4.5"));
        let _ = fs::remove_dir_all(&dir);
    }

    const CODEX_TURN: &str = r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#;
    const CODEX_COUNT: &str = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":420},"model_context_window":272000}}}"#;
    const COPILOT_START: &str =
        r#"{"type":"session.start","data":{"selectedModel":"gpt-5"}}"#;
    const COPILOT_CHANGE: &str =
        r#"{"type":"session.model_change","data":{"newModel":"claude-sonnet-4.5"}}"#;

    #[test]
    fn context_serializes_camel_case() {
        let v = serde_json::to_value(ctx("s")).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "sessionId": "s", "model": "m", "contextTokens": 1, "contextWindow": null })
        );
    }
}
