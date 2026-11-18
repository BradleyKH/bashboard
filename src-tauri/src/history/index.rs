//! The history index behind the Sessions dialog: walks each agent's transcripts, reads only the
//! head and tail of a file that changed since the last build, and keeps the parsed rows in
//! `history-cache.json` keyed by path, size, and mtime so a warm build touches only metadata.
//! A watcher on each agent's transcript folder rebuilds incrementally and emits
//! `history://changed` with the full list when it differs.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::{claude, codex, copilot, repo, PastSession};
use crate::agents::AgentId;
use crate::lock::LockExt;

/// A first prompt over about 7 KB would straddle an 8 KB head, so the head is larger.
const HEAD: u64 = 16 * 1024;
const TAIL: u64 = 64 * 1024;
const CACHE_FILE: &str = "history-cache.json";
/// Bump when a reader's output changes so old cached rows are re-read.
const CACHE_VERSION: u32 = 1;
const DEBOUNCE: Duration = Duration::from_secs(1);
/// A transcript being streamed never goes quiet for a full debounce, so a burst is cut off here.
const DEBOUNCE_MAX: Duration = Duration::from_secs(5);
/// How often a watch root missing at startup (agent installed later) is retried.
const RETRY: Duration = Duration::from_secs(30);

/// `(size, mtime_ms)` of a file.
type Stamp = (u64, u64);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Entry {
    stamp: Stamp,
    /// Copilot's `workspace.yaml` beside `events.jsonl`: its summary and cwd change on their own.
    #[serde(default)]
    side: Option<Stamp>,
    /// `None` when the file held no resumable session, so it is not re-read either.
    session: Option<PastSession>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    entries: HashMap<String, Entry>,
}

/// The cache and the last list built from it.
#[derive(Debug, Default)]
struct Index {
    entries: HashMap<String, Entry>,
    list: Option<Vec<PastSession>>,
}

/// What a build did, for the cache write and the tests.
#[derive(Debug, Default, PartialEq, Eq)]
struct BuildStats {
    reads: usize,
    dropped: usize,
}

impl BuildStats {
    fn changed(&self) -> bool {
        self.reads > 0 || self.dropped > 0
    }
}

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some((meta.len(), mtime))
}

/// The first `HEAD` and last `TAIL` bytes as text, or the whole file twice when it is no bigger
/// than both, as `super::complete_lines` expects.
fn head_tail(path: &Path, size: u64) -> Option<(String, String)> {
    let mut file = File::open(path).ok()?;
    if size <= HEAD + TAIL {
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Some((text.clone(), text));
    }
    let mut head = vec![0; HEAD as usize];
    file.read_exact(&mut head).ok()?;
    file.seek(SeekFrom::Start(size - TAIL)).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    // A cut inside a UTF-8 sequence becomes a replacement character in a line the readers drop.
    Some((
        String::from_utf8_lossy(&head).into_owned(),
        String::from_utf8_lossy(&tail).into_owned(),
    ))
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn parent_name(path: &Path) -> String {
    path.parent()
        .and_then(Path::file_name)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Codex's title rule from `codex::read`, re-applied to cached rows since a rename touches only
/// `session_index.jsonl`, never the rollout.
fn codex_title(s: &PastSession, names: &HashMap<String, String>) -> String {
    names
        .get(&s.session_id)
        .cloned()
        .or_else(|| s.first_prompt.clone())
        .or_else(|| s.last_prompt.clone())
        .unwrap_or_else(|| s.session_id.clone())
}

impl Index {
    /// Rebuilds the list from `homes`, re-reading only new or changed files and dropping entries
    /// whose files are gone.
    fn build(&mut self, homes: &[(AgentId, PathBuf)]) -> (Vec<PastSession>, BuildStats) {
        let mut stats = BuildStats::default();
        let mut seen: HashSet<String> = HashSet::new();
        let mut list = Vec::new();
        let mut names = HashMap::new();
        for (agent, home) in homes {
            let paths = match agent {
                AgentId::Claude => claude::transcripts(home),
                AgentId::Codex => {
                    names = std::fs::read_to_string(home.join("session_index.jsonl"))
                        .map(|t| codex::parse_session_index(&t))
                        .unwrap_or_default();
                    codex::transcripts(home)
                }
                AgentId::Copilot => copilot::transcripts(home),
            };
            for path in paths {
                let Some(st) = stamp(&path) else { continue };
                let side = match agent {
                    AgentId::Copilot => stamp(&copilot::workspace_path(&path)),
                    _ => None,
                };
                let key = path.to_string_lossy().into_owned();
                seen.insert(key.clone());
                let fresh = self
                    .entries
                    .get(&key)
                    .is_some_and(|e| e.stamp == st && e.side == side);
                if !fresh {
                    stats.reads += 1;
                    let session = head_tail(&path, st.0).and_then(|(head, tail)| match agent {
                        AgentId::Claude => claude::read(&file_stem(&path), &head, &tail, st.1),
                        AgentId::Codex => codex::read(&head, &tail, st.1, &names),
                        AgentId::Copilot => {
                            let yaml = std::fs::read_to_string(copilot::workspace_path(&path)).ok();
                            copilot::read(&parent_name(&path), yaml.as_deref(), &head, &tail, st.1)
                        }
                    });
                    self.entries.insert(
                        key.clone(),
                        Entry {
                            stamp: st,
                            side,
                            session,
                        },
                    );
                }
                if let Some(mut s) = self.entries[&key].session.clone() {
                    if s.agent == AgentId::Codex {
                        s.title = codex_title(&s, &names);
                    }
                    list.push(s);
                }
            }
        }
        let before = self.entries.len();
        self.entries.retain(|k, _| seen.contains(k));
        stats.dropped = before - self.entries.len();

        // Never cached: a folder or worktree can be deleted after its rows were read.
        let mut memo: HashMap<String, (bool, Option<String>)> = HashMap::new();
        for s in &mut list {
            let (exists, root) = memo
                .entry(s.cwd.clone())
                .or_insert_with(|| {
                    if s.cwd.is_empty() {
                        return (false, None);
                    }
                    let p = Path::new(&s.cwd);
                    (
                        p.is_dir(),
                        repo::main_repo_root(p).map(|r| crate::files::display(&r)),
                    )
                })
                .clone();
            s.cwd_exists = exists;
            s.repo_root = root;
        }
        list.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        (list, stats)
    }
}

fn load_cache(path: &Path) -> HashMap<String, Entry> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<CacheFile>(&b).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .map(|c| c.entries)
        .unwrap_or_default()
}

fn save_cache(path: &Path, entries: &HashMap<String, Entry>) {
    let file = CacheFile {
        version: CACHE_VERSION,
        entries: entries.clone(),
    };
    match serde_json::to_vec(&file) {
        Ok(bytes) => {
            if let Err(e) = crate::atomic_file::write_atomic(path, bytes) {
                eprintln!("history: could not write {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("history: could not serialize the cache: {e}"),
    }
}

fn agent_homes() -> Vec<(AgentId, PathBuf)> {
    AgentId::ALL
        .into_iter()
        .filter_map(|id| id.agent().home().map(|h| (id, h)))
        .collect()
}

/// The folders to watch per agent: transcripts recursively, plus Codex's home itself for
/// `session_index.jsonl`.
fn watch_targets(homes: &[(AgentId, PathBuf)]) -> Vec<(PathBuf, RecursiveMode)> {
    let mut out = Vec::new();
    for (agent, home) in homes {
        match agent {
            AgentId::Claude => out.push((home.join("projects"), RecursiveMode::Recursive)),
            AgentId::Codex => {
                out.push((home.join("sessions"), RecursiveMode::Recursive));
                out.push((home.clone(), RecursiveMode::NonRecursive));
            }
            AgentId::Copilot => out.push((home.join("session-state"), RecursiveMode::Recursive)),
        }
    }
    out
}

pub struct History {
    /// Held across a build, so the command and the watcher thread never build at once.
    index: Mutex<Index>,
    loaded: Mutex<bool>,
    // Held only so the watchers live as long as the app; `None` while a root is missing.
    watchers: Mutex<Vec<Option<RecommendedWatcher>>>,
}

impl Default for History {
    fn default() -> Self {
        Self {
            index: Mutex::new(Index::default()),
            loaded: Mutex::new(false),
            watchers: Mutex::new(Vec::new()),
        }
    }
}

/// Builds the list, saving the cache when anything was re-read or dropped, and emits
/// `history://changed` when the list differs from the last one. Returns the list.
fn rebuild(app: &AppHandle, emit: bool) -> Vec<PastSession> {
    let state = app.state::<History>();
    let cache_path = crate::config_dir::config_dir(app).map(|d| d.join(CACHE_FILE));
    let mut index = state.index.lock_or_recover();
    {
        let mut loaded = state.loaded.lock_or_recover();
        if !*loaded {
            if let Some(p) = &cache_path {
                index.entries = load_cache(p);
            }
            *loaded = true;
        }
    }
    let (list, stats) = index.build(&agent_homes());
    if stats.changed() {
        if let Some(p) = &cache_path {
            save_cache(p, &index.entries);
        }
    }
    if index.list.as_ref() != Some(&list) {
        let first = index.list.is_none();
        index.list = Some(list.clone());
        if emit && !first {
            let _ = app.emit("history://changed", &list);
        }
    }
    list
}

/// The cached list, built on the first call off the main thread.
#[tauri::command]
pub async fn session_history_list(app: AppHandle) -> Result<Vec<PastSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(list) = app.state::<History>().index.lock_or_recover().list.clone() {
            return list;
        }
        rebuild(&app, false)
    })
    .await
    .map_err(|e| e.to_string())
}

/// The main repo root holding `cwd`, so a terminal's scope matches the rows' `repo_root` even in
/// a worktree or a repo with no indexed sessions.
#[tauri::command]
pub async fn session_history_repo_root(cwd: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        repo::main_repo_root(Path::new(&cwd)).map(|r| crate::files::display(&r))
    })
    .await
    .ok()
    .flatten()
}

/// Starts the watcher thread. Nothing is built until the first `session_history_list`; after
/// that each relevant change rebuilds incrementally.
pub fn init(app: &AppHandle) {
    let targets = watch_targets(&agent_homes());
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let watch = {
        let app = app.clone();
        move |tx: &mpsc::Sender<_>| {
            let state = app.state::<History>();
            let mut slots = state.watchers.lock_or_recover();
            slots.resize_with(targets.len(), || None);
            for ((dir, mode), slot) in targets.iter().zip(slots.iter_mut()) {
                if slot.is_none() && dir.is_dir() {
                    *slot = notify::recommended_watcher(tx.clone())
                        .ok()
                        .and_then(|mut w| w.watch(dir, *mode).ok().map(|_| w));
                }
            }
        }
    };
    watch(&tx);

    let app = app.clone();
    thread::spawn(move || {
        let relevant = |ev: &notify::Result<notify::Event>| {
            !crate::fs_events::is_access(ev)
                && ev.as_ref().is_ok_and(|e| {
                    e.paths
                        .iter()
                        .any(|p| p.extension().is_some_and(|x| x == "jsonl" || x == "yaml"))
                })
        };
        loop {
            match rx.recv_timeout(RETRY) {
                Ok(ev) => {
                    if !relevant(&ev) {
                        continue;
                    }
                    let start = Instant::now();
                    while start.elapsed() < DEBOUNCE_MAX && rx.recv_timeout(DEBOUNCE).is_ok() {}
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    watch(&tx);
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            let built = app
                .state::<History>()
                .index
                .lock_or_recover()
                .list
                .is_some();
            if built {
                rebuild(&app, true);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bashboard-history-index-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn claude_transcript(prompt: &str, time: &str) -> String {
        format!(
            "{{\"type\":\"user\",\"cwd\":\"C:\\\\nowhere\\\\app\",\"sessionId\":\"x\",\"timestamp\":\"{time}\",\"message\":{{\"role\":\"user\",\"content\":\"{prompt}\"}}}}\n"
        )
    }

    /// Bumps a file's mtime without depending on the clock's resolution.
    fn touch(path: &Path, ms: u64) {
        let t = UNIX_EPOCH + Duration::from_millis(ms);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    #[test]
    fn rereads_only_changed_files_and_drops_deleted_ones() {
        let home = temp_home("claude");
        let proj = home.join("projects").join("C--nowhere-app");
        fs::create_dir_all(&proj).unwrap();
        let a = proj.join("aaaa.jsonl");
        let b = proj.join("bbbb.jsonl");
        fs::write(&a, claude_transcript("first a", "2026-11-17T10:00:00Z")).unwrap();
        fs::write(&b, claude_transcript("first b", "2026-11-17T11:00:00Z")).unwrap();
        let homes = vec![(AgentId::Claude, home.clone())];

        let mut index = Index::default();
        let (list, stats) = index.build(&homes);
        assert_eq!(stats.reads, 2);
        assert_eq!(
            list.iter()
                .map(|s| s.session_id.as_str())
                .collect::<Vec<_>>(),
            ["bbbb", "aaaa"]
        );
        assert_eq!(list[0].title, "first b");
        assert!(!list[0].cwd_exists);

        // Unchanged files come from the cache.
        let (again, stats) = index.build(&homes);
        assert_eq!(stats, BuildStats::default());
        assert_eq!(again, list);

        // A changed mtime re-reads just that file.
        fs::write(&a, claude_transcript("edited a", "2026-11-17T12:00:00Z")).unwrap();
        touch(&a, 1_900_000_000_000);
        let (list, stats) = index.build(&homes);
        assert_eq!(stats.reads, 1);
        assert_eq!(list[0].session_id, "aaaa");
        assert_eq!(list[0].title, "edited a");

        // A deleted file drops out of the list and the cache.
        fs::remove_file(&b).unwrap();
        let (list, stats) = index.build(&homes);
        assert_eq!(
            stats,
            BuildStats {
                reads: 0,
                dropped: 1
            }
        );
        assert_eq!(list.len(), 1);
        assert_eq!(index.entries.len(), 1);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn cache_round_trips_through_disk() {
        let home = temp_home("cache");
        let proj = home.join("projects").join("p");
        fs::create_dir_all(&proj).unwrap();
        fs::write(
            proj.join("cccc.jsonl"),
            claude_transcript("hello", "2026-11-17T10:00:00Z"),
        )
        .unwrap();
        let homes = vec![(AgentId::Claude, home.clone())];
        let mut index = Index::default();
        let (list, _) = index.build(&homes);
        let cache = home.join(CACHE_FILE);
        save_cache(&cache, &index.entries);

        let mut warm = Index {
            entries: load_cache(&cache),
            list: None,
        };
        let (again, stats) = warm.build(&homes);
        assert_eq!(stats.reads, 0);
        assert_eq!(again, list);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_renames_reach_cached_rows() {
        let home = temp_home("codex");
        let day = home.join("sessions").join("2026").join("11").join("17");
        fs::create_dir_all(&day).unwrap();
        let id = "019a1b2c-0000-7000-8000-abcdefabcdef";
        fs::write(
            day.join(format!("rollout-2026-11-17T10-00-00-{id}.jsonl")),
            format!(
                "{{\"timestamp\":\"2026-11-17T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"C:\\\\nowhere\"}}}}\n\
                 {{\"timestamp\":\"2026-11-17T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"do the thing\"}}}}\n"
            ),
        )
        .unwrap();
        let homes = vec![(AgentId::Codex, home.clone())];
        let mut index = Index::default();
        let (list, _) = index.build(&homes);
        assert_eq!(list[0].title, "do the thing");

        fs::write(
            home.join("session_index.jsonl"),
            format!("{{\"id\":\"{id}\",\"thread_name\":\"Renamed\"}}\n"),
        )
        .unwrap();
        let (list, stats) = index.build(&homes);
        assert_eq!(stats.reads, 0);
        assert_eq!(list[0].title, "Renamed");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn copilot_workspace_change_rereads() {
        let home = temp_home("copilot");
        let dir = home.join("session-state").join("sess-1");
        fs::create_dir_all(&dir).unwrap();
        let events = dir.join("events.jsonl");
        fs::write(
            &events,
            "{\"type\":\"user.message\",\"timestamp\":\"2026-11-17T10:00:00Z\",\"data\":{\"content\":\"hi there\"}}\n",
        )
        .unwrap();
        let yaml = dir.join("workspace.yaml");
        fs::write(&yaml, "cwd: C:\\nowhere\nsummary: Old summary\n").unwrap();
        let homes = vec![(AgentId::Copilot, home.clone())];
        let mut index = Index::default();
        let (list, _) = index.build(&homes);
        assert_eq!(list.len(), 1);
        let old_title = list[0].title.clone();

        fs::write(&yaml, "cwd: C:\\nowhere\nsummary: A much newer summary\n").unwrap();
        touch(&yaml, 1_900_000_000_000);
        let (list, stats) = index.build(&homes);
        assert_eq!(stats.reads, 1);
        assert_ne!(list[0].title, old_title);
        let _ = fs::remove_dir_all(&home);
    }
}
