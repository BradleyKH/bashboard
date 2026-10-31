//! Session transcripts (design sections 3.3 and 3.4): finds each pane-bound Claude session's JSONL
//! transcript, tails it for the newest model and context size, and emits `claude://context` when
//! either changes. The format is internal to Claude Code and undocumented, so every field is
//! optional and an unreadable line is skipped.

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

use crate::hooks::HookOverlay;
use crate::roster::Session;

/// How much of a transcript's end is read first; transcripts grow to many megabytes.
const TAIL: u64 = 64 * 1024;
const TICK: Duration = Duration::from_millis(250);
/// At most one read per second per session while appends stream in.
const READ_EVERY: Duration = Duration::from_secs(1);
/// Claude Code may create the transcript only after the first message.
const SEARCH_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContextReading {
    model: Option<String>,
    tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeContext {
    pub session_id: String,
    pub model: Option<String>,
    pub context_tokens: Option<u64>,
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

/// Reads the last `TAIL` bytes, widening to a streamed pass over the whole file only when the
/// tail holds no qualifying line.
fn read_newest(path: &Path) -> io::Result<Option<ContextReading>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)?;
    // Lossy, since the cut may split a UTF-8 sequence.
    let text = String::from_utf8_lossy(&bytes);
    let text = if start > 0 {
        // The first line is partial when the read starts mid-file.
        text.split_once('\n').map_or("", |(_, rest)| rest)
    } else {
        &text
    };
    if let Some(reading) = newest_in(text) {
        return Ok(Some(reading));
    }
    if start == 0 {
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

/// The first `<projects>/*/<sessionId>.jsonl` that is a file.
fn find_by_session(projects: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.contains(['/', '\\', ':']) || session_id.contains("..") {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

fn projects_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".claude").join("projects"))
}

/// Watcher events and hook paths may differ in case and separators for the same file.
fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

#[derive(Debug, Default)]
struct Tracked {
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
    contexts: HashMap<String, ClaudeContext>,
}

/// Session ids with their hook `transcript_path`, as `sync` sends them.
type SyncList = Vec<(String, Option<String>)>;

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
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(msg);
        }
    }

    pub fn prune(&self, live: &HashSet<&str>) {
        let mut inner = self.inner.lock().unwrap();
        inner.tracked.retain(|id, _| live.contains(id.as_str()));
        inner.contexts.retain(|id, _| live.contains(id.as_str()));
    }
}

/// Starts tracking on the first call, so a user with the Claude section off pays nothing, and
/// returns every known context so a page reload shows them at once.
#[tauri::command]
pub fn claude_context(state: State<'_, Transcripts>) -> Vec<ClaudeContext> {
    let (woke, mut out) = {
        let mut inner = state.inner.lock().unwrap();
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

fn sync_list(sessions: &[Session], overlay: &HashMap<String, HookOverlay>) -> SyncList {
    sessions
        .iter()
        .filter(|s| s.pane_id.is_some())
        .map(|s| {
            let hook = overlay
                .get(&s.session_id)
                .and_then(|o| o.transcript_path.clone());
            (s.session_id.clone(), hook)
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
    let listed: HashSet<&str> = list.iter().map(|(id, _)| id.as_str()).collect();
    inner.tracked.retain(|id, _| listed.contains(id.as_str()));
    inner.contexts.retain(|id, _| listed.contains(id.as_str()));
    for (id, hook) in list {
        let hook = hook.filter(|h| !h.is_empty()).map(PathBuf::from);
        let t = inner.tracked.entry(id).or_default();
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
    projects: Option<PathBuf>,
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
                &mut self.app.state::<Transcripts>().inner.lock().unwrap(),
                &event,
            ),
            Msg::Fs(Err(_)) | Msg::Wake => {}
        }
    }

    fn tick(&mut self, now: Instant) {
        let app = self.app.clone();
        let state = app.state::<Transcripts>();
        let to_search: Vec<String> = {
            let mut inner = state.inner.lock().unwrap();
            if !inner.active {
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
                    id.clone()
                })
                .collect()
        };
        let found: Vec<(String, PathBuf)> = match &self.projects {
            Some(projects) => to_search
                .into_iter()
                .filter_map(|id| find_by_session(projects, &id).map(|p| (id, p)))
                .collect(),
            None => Vec::new(),
        };

        let (to_read, wanted) = {
            let mut inner = state.inner.lock().unwrap();
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
            let to_read: Vec<(String, PathBuf)> = inner
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
                    Some((id.clone(), path))
                })
                .collect();
            (to_read, wanted)
        };

        self.update_watches(wanted);

        let readings: Vec<(String, ContextReading)> = to_read
            .into_iter()
            .filter_map(|(id, path)| read_newest(&path).ok().flatten().map(|r| (id, r)))
            .collect();
        if readings.is_empty() {
            return;
        }
        let changed: Vec<ClaudeContext> = {
            let mut inner = state.inner.lock().unwrap();
            let inner = &mut *inner;
            let mut changed = Vec::new();
            for (id, r) in readings {
                if !inner.tracked.contains_key(&id) {
                    continue;
                }
                let next = ClaudeContext {
                    session_id: id.clone(),
                    model: r.model,
                    context_tokens: Some(r.tokens),
                };
                if inner.contexts.get(&id) != Some(&next) {
                    inner.contexts.insert(id, next.clone());
                    changed.push(next);
                }
            }
            changed
        };
        for ctx in changed {
            let _ = app.emit("claude://context", ctx);
        }
    }

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

/// Starts the worker thread. Nothing is tracked until `claude_context` first runs.
pub fn init(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<Msg>();
    *app.state::<Transcripts>().tx.lock().unwrap() = Some(tx.clone());
    let mut worker = Worker {
        app: app.clone(),
        projects: projects_dir(),
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

    fn ctx(id: &str) -> ClaudeContext {
        ClaudeContext {
            session_id: id.into(),
            model: Some("m".into()),
            context_tokens: Some(1),
        }
    }

    #[test]
    fn prune_drops_non_live_sessions() {
        let t = Transcripts::default();
        {
            let mut inner = t.inner.lock().unwrap();
            for id in ["live", "gone"] {
                inner.tracked.insert(id.into(), Tracked::default());
                inner.contexts.insert(id.into(), ctx(id));
            }
        }
        t.prune(&HashSet::from(["live"]));
        let inner = t.inner.lock().unwrap();
        assert_eq!(inner.tracked.keys().collect::<Vec<_>>(), ["live"]);
        assert_eq!(inner.contexts.keys().collect::<Vec<_>>(), ["live"]);
    }

    #[test]
    fn sync_adds_drops_and_switches_hook_paths() {
        let mut inner = Inner::default();
        apply_sync(
            &mut inner,
            vec![
                ("a".into(), None),
                ("b".into(), Some("C:\\b1.jsonl".into())),
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
                ("a".into(), None),
                ("b".into(), Some("C:\\b1.jsonl".into())),
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
                ("a".into(), None),
                ("b".into(), Some("C:\\b2.jsonl".into())),
            ],
        );
        assert_eq!(
            inner.tracked["b"].path.as_deref(),
            Some(Path::new("C:\\b2.jsonl"))
        );
        assert!(inner.tracked["b"].dirty);

        apply_sync(&mut inner, vec![("b".into(), None)]);
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
                ("a".into(), Some("C:\\Users\\Me\\t.jsonl".into())),
                ("b".into(), None),
            ],
        );
        inner.tracked.get_mut("a").unwrap().dirty = false;
        let event = notify::Event::new(notify::EventKind::Any)
            .add_path(PathBuf::from("c:/users/me/T.jsonl"));
        mark_dirty(&mut inner, &event);
        assert!(inner.tracked["a"].dirty);
        assert!(!inner.tracked["b"].dirty);
    }

    #[test]
    fn sync_list_keeps_pane_bound_sessions_with_hook_paths() {
        let session = |id: &str, pane_id: Option<u32>| Session {
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
        };
        let sessions = [
            session("hooked", Some(1)),
            session("ancestry", Some(2)),
            session("external", None),
        ];
        let overlay = HashMap::from([
            (
                "hooked".to_string(),
                HookOverlay {
                    transcript_path: Some("C:\\t.jsonl".into()),
                    ..Default::default()
                },
            ),
            (
                "external".to_string(),
                HookOverlay {
                    transcript_path: Some("C:\\e.jsonl".into()),
                    ..Default::default()
                },
            ),
        ]);
        assert_eq!(
            sync_list(&sessions, &overlay),
            vec![
                ("hooked".to_string(), Some("C:\\t.jsonl".to_string())),
                ("ancestry".to_string(), None)
            ]
        );
    }

    #[test]
    fn context_serializes_camel_case() {
        let v = serde_json::to_value(ctx("s")).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "sessionId": "s", "model": "m", "contextTokens": 1 })
        );
    }
}
