//! The Git pane's remote commands and the background fetch scheduler (design section 3.9).
//!
//! Fetch state is keyed by a repo's common git dir, so Git panes on two worktrees of one repo
//! share one record and one background fetch. Records outlive the panes for the session.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{files::display, git::Git, settings::SettingsState};

/// The scheduler wakes at least this often to pick up due repos and setting changes.
const TICK: Duration = Duration::from_secs(30);
const MAX_BACKGROUND_FAILURES: u32 = 3;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRecord {
    #[serde(rename = "time")]
    pub time_ms: u64,
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Serialize)]
struct GitFetched {
    roots: Vec<String>,
}

#[derive(Default)]
struct RepoState {
    last: Option<FetchRecord>,
    failures: u32,
    skipped: bool,
}

/// Which repos are open and when each was last fetched. No threads or I/O, so it is unit-tested.
#[derive(Default)]
struct Schedule {
    /// (root, key) for every root with an open Git pane.
    roots: Vec<(String, String)>,
    repos: HashMap<String, RepoState>,
}

impl Schedule {
    fn set_roots(&mut self, roots: Vec<(String, String)>) {
        self.roots = roots;
    }

    /// One (key, root) per registered repo whose last attempt is missing or an interval old.
    fn due(&self, now_ms: u64, interval_minutes: u32) -> Vec<(String, String)> {
        if interval_minutes == 0 {
            return Vec::new();
        }
        let interval_ms = u64::from(interval_minutes) * 60_000;
        let mut seen = HashSet::new();
        self.roots
            .iter()
            .filter(|(_, key)| seen.insert(key.as_str()))
            .filter(|(_, key)| match self.repos.get(key) {
                None => true,
                Some(r) => {
                    !r.skipped
                        && r.last
                            .as_ref()
                            .is_none_or(|l| now_ms.saturating_sub(l.time_ms) >= interval_ms)
                }
            })
            .map(|(root, key)| (key.clone(), root.clone()))
            .collect()
    }

    fn record(&mut self, key: &str, now_ms: u64, outcome: &Result<(), String>, background: bool) {
        let repo = self.repos.entry(key.to_string()).or_default();
        repo.last = Some(FetchRecord {
            time_ms: now_ms,
            ok: outcome.is_ok(),
            message: outcome.as_ref().err().cloned().unwrap_or_default(),
        });
        if !background {
            // A manual fetch is the user's retry, so a skipped repo rejoins the schedule.
            repo.failures = 0;
            repo.skipped = false;
        } else if outcome.is_ok() {
            repo.failures = 0;
        } else {
            repo.failures += 1;
            if repo.failures >= MAX_BACKGROUND_FAILURES {
                repo.skipped = true;
            }
        }
    }

    fn last(&self, key: &str) -> Option<FetchRecord> {
        self.repos.get(key).and_then(|r| r.last.clone())
    }

    fn roots_for(&self, key: &str) -> Vec<String> {
        self.roots
            .iter()
            .filter(|(_, k)| k == key)
            .map(|(root, _)| root.clone())
            .collect()
    }
}

struct Inner {
    schedule: Schedule,
    /// Root as the front end spelled it to its key, so a roots update does not respawn git.
    keys: HashMap<String, String>,
    visible: bool,
    wake: bool,
}

pub struct GitFetches {
    inner: Mutex<Inner>,
    wake: Condvar,
    /// Held for the length of a fetch, so a manual and a background fetch of one repo never
    /// run at once.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Default for GitFetches {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                schedule: Schedule::default(),
                keys: HashMap::new(),
                visible: true,
                wake: false,
            }),
            wake: Condvar::new(),
            locks: Mutex::new(HashMap::new()),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The key for a repo: its common git dir, absolute and lowercased like `git_watch`'s root keys.
fn resolve_key(git: &Git) -> Result<String, String> {
    let dir: PathBuf = git.common_dir()?;
    let dir = std::path::absolute(&dir).map_err(|e| format!("{}: {e}", display(&dir)))?;
    Ok(display(&dir).to_lowercase())
}

impl GitFetches {
    fn key_for_root(&self, settings: &SettingsState, root: &str) -> Result<String, String> {
        if let Some(key) = self.inner.lock().unwrap().keys.get(root) {
            return Ok(key.clone());
        }
        let key = resolve_key(&Git::open(settings, root)?)?;
        self.inner
            .lock()
            .unwrap()
            .keys
            .insert(root.to_string(), key.clone());
        Ok(key)
    }

    fn fetch_lock(&self, key: &str) -> Arc<Mutex<()>> {
        self.locks
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    fn notify(&self, inner: &mut Inner) {
        inner.wake = true;
        self.wake.notify_all();
    }

    /// Records a fetch and tells the panes on that repo, plus `extra` (the root a manual
    /// command ran on, which may have no pane registered).
    fn finish(
        &self,
        app: &AppHandle,
        key: &str,
        outcome: &Result<(), String>,
        background: bool,
        extra: Option<&str>,
    ) {
        let mut roots = {
            let mut inner = self.inner.lock().unwrap();
            inner.schedule.record(key, now_ms(), outcome, background);
            inner.schedule.roots_for(key)
        };
        if let Some(root) = extra {
            if !roots.iter().any(|r| r == root) {
                roots.push(root.to_string());
            }
        }
        let _ = app.emit("git://fetched", GitFetched { roots });
    }

    fn wait(&self) {
        let inner = self.inner.lock().unwrap();
        let (mut inner, _) = self
            .wake
            .wait_timeout_while(inner, TICK, |i| !i.wake)
            .unwrap();
        inner.wake = false;
    }
}

fn run_due(app: &AppHandle) {
    let settings = app.state::<SettingsState>();
    let state = app.state::<GitFetches>();
    let interval = settings.current().git.auto_fetch_minutes;
    let due = {
        let inner = state.inner.lock().unwrap();
        if !inner.visible {
            return;
        }
        inner.schedule.due(now_ms(), interval)
    };
    for (key, root) in due {
        if !state.inner.lock().unwrap().visible {
            return;
        }
        let lock = state.fetch_lock(&key);
        // A manual fetch of this repo is running; it records its own outcome.
        let Ok(_guard) = lock.try_lock() else {
            continue;
        };
        let outcome = Git::open(&settings, &root).and_then(|g| g.fetch(true));
        if let Err(e) = &outcome {
            eprintln!("background fetch of {root} failed: {e}");
        }
        state.finish(app, &key, &outcome, true, None);
    }
}

/// Starts the background fetch scheduler. The interval is read from the settings on each pass,
/// so a change to `git.autoFetchMinutes` applies without restarting it.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        loop {
            run_due(&app);
            app.state::<GitFetches>().wait();
        }
    });
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

#[tauri::command]
pub async fn git_fetch(app: AppHandle, root: String, background: bool) -> Result<(), String> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let state = app.state::<GitFetches>();
        let key = state.key_for_root(&settings, &root)?;
        let git = Git::open(&settings, &root)?;
        let outcome = {
            let lock = state.fetch_lock(&key);
            let _guard = lock.lock().unwrap();
            git.fetch(background)
        };
        state.finish(&app, &key, &outcome, background, Some(&root));
        outcome
    })
    .await
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, root: String) -> Result<(), String> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let state = app.state::<GitFetches>();
        let key = state.key_for_root(&settings, &root)?;
        let git = Git::open(&settings, &root)?;
        let outcome = {
            let lock = state.fetch_lock(&key);
            let _guard = lock.lock().unwrap();
            git.pull()
        };
        // A pull fetches, so a successful one counts as this repo's latest fetch.
        if outcome.is_ok() {
            state.finish(&app, &key, &outcome, false, Some(&root));
        }
        outcome
    })
    .await
}

#[tauri::command]
pub async fn git_push(
    app: AppHandle,
    root: String,
    up_to: Option<String>,
) -> Result<(), String> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let git = Git::open(&settings, &root)?;
        match up_to {
            Some(hash) => git.push_up_to(&hash),
            None => git.push(),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_last_fetch(app: AppHandle, root: String) -> Result<Option<FetchRecord>, String> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let state = app.state::<GitFetches>();
        let key = state.key_for_root(&settings, &root)?;
        Ok(state.inner.lock().unwrap().schedule.last(&key))
    })
    .await
}

/// Replaces the roots with an open Git pane. A root that does not resolve to a repo is dropped.
#[tauri::command]
pub async fn git_fetch_roots(app: AppHandle, roots: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let state = app.state::<GitFetches>();
        let keyed = roots
            .into_iter()
            .filter_map(|root| {
                let key = state.key_for_root(&settings, &root).ok()?;
                Some((root, key))
            })
            .collect();
        let mut inner = state.inner.lock().unwrap();
        inner.schedule.set_roots(keyed);
        state.notify(&mut inner);
        Ok(())
    })
    .await
}

/// The window is hidden or minimized when `visible` is false; background fetch pauses then and
/// catches up when it turns true.
#[tauri::command]
pub fn git_fetch_visible(state: State<'_, GitFetches>, visible: bool) {
    let mut inner = state.inner.lock().unwrap();
    let was = inner.visible;
    inner.visible = visible;
    if visible && !was {
        state.notify(&mut inner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{commit_file, repo, sh, temp_dir};
    use std::{fs, path::Path};

    const MIN: u64 = 60_000;

    fn ok() -> Result<(), String> {
        Ok(())
    }

    fn failed() -> Result<(), String> {
        Err("fatal: unable to access".into())
    }

    fn roots(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(r, k)| (r.to_string(), k.to_string()))
            .collect()
    }

    fn keys(due: &[(String, String)]) -> Vec<&str> {
        due.iter().map(|(k, _)| k.as_str()).collect()
    }

    #[test]
    fn schedule_due_on_first_sight_and_after_the_interval() {
        let mut s = Schedule::default();
        s.set_roots(roots(&[("C:/a", "a")]));
        assert_eq!(s.due(0, 5), vec![("a".to_string(), "C:/a".to_string())]);
        s.record("a", 10 * MIN, &ok(), true);
        assert!(s.due(14 * MIN, 5).is_empty());
        assert_eq!(keys(&s.due(15 * MIN, 5)), ["a"]);
    }

    #[test]
    fn schedule_interval_zero_gives_nothing() {
        let mut s = Schedule::default();
        s.set_roots(roots(&[("C:/a", "a")]));
        assert!(s.due(0, 0).is_empty());
    }

    #[test]
    fn schedule_three_background_failures_skip_until_a_manual_fetch() {
        let mut s = Schedule::default();
        s.set_roots(roots(&[("C:/a", "a")]));
        s.record("a", 0, &failed(), true);
        s.record("a", MIN, &failed(), true);
        assert_eq!(keys(&s.due(10 * MIN, 1)), ["a"]);
        s.record("a", 2 * MIN, &failed(), true);
        assert!(s.due(100 * MIN, 1).is_empty());
        let last = s.last("a").unwrap();
        assert!(!last.ok);
        assert_eq!(last.message, "fatal: unable to access");

        s.record("a", 100 * MIN, &failed(), false);
        assert_eq!(keys(&s.due(101 * MIN, 1)), ["a"]);
    }

    #[test]
    fn schedule_background_success_resets_the_failure_count() {
        let mut s = Schedule::default();
        s.set_roots(roots(&[("C:/a", "a")]));
        s.record("a", 0, &failed(), true);
        s.record("a", MIN, &failed(), true);
        s.record("a", 2 * MIN, &ok(), true);
        s.record("a", 3 * MIN, &failed(), true);
        s.record("a", 4 * MIN, &failed(), true);
        assert_eq!(keys(&s.due(5 * MIN, 1)), ["a"]);
        assert!(s.last("a").unwrap().message.starts_with("fatal"));
    }

    #[test]
    fn schedule_two_roots_on_one_key_give_one_due_entry() {
        let mut s = Schedule::default();
        s.set_roots(roots(&[
            ("C:/main", "k"),
            ("C:/wt", "k"),
            ("C:/other", "o"),
        ]));
        let due = s.due(0, 5);
        assert_eq!(keys(&due), ["k", "o"]);
        assert_eq!(due[0].1, "C:/main");
        assert_eq!(s.roots_for("k"), ["C:/main", "C:/wt"]);
    }

    #[test]
    fn schedule_records_survive_dropping_the_root() {
        let mut s = Schedule::default();
        s.set_roots(roots(&[("C:/a", "a")]));
        s.record("a", 0, &ok(), false);
        s.set_roots(Vec::new());
        assert!(s.last("a").unwrap().ok);
        assert!(s.roots_for("a").is_empty());
        s.set_roots(roots(&[("C:/a", "a")]));
        assert!(s.due(MIN, 5).is_empty());
    }

    #[test]
    fn git_fetch_worktrees_share_a_key() {
        let main = repo("main");
        let other = repo("other");
        // The initial commit gives the worktree a HEAD to start from.
        commit_file(&main, "a.txt", "a", "first");
        let wt = temp_dir("wt");
        fs::remove_dir_all(&wt).unwrap();
        sh(
            main.root(),
            &["worktree", "add", "-q", &wt.to_string_lossy(), "-b", "side"],
        );

        let settings = SettingsState::default();
        let key = |p: &Path| resolve_key(&Git::open(&settings, &display(p)).unwrap()).unwrap();
        let main_key = key(main.root());
        assert_eq!(main_key, key(&wt));
        assert_ne!(main_key, key(other.root()));
        assert_eq!(main_key, main_key.to_lowercase());

        let _ = fs::remove_dir_all(&wt);
    }
}
