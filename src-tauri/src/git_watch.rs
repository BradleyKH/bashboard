//! Watches a repo's git metadata and worktree and emits `git://changed` (design section 3.9).
//!
//! One watcher per normalized root, shared by every Git pane on that repo through a reference
//! count. Metadata means `HEAD`, `index`, `packed-refs`, and `refs/`, never `objects/`, which is
//! where the write volume is. A worktree change counts unless its path is gitignored or inside a
//! `.git`, so a build writing to an ignored `target/` does not refresh the pane.

use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use ignore::{Match, gitignore::Gitignore};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::files::{display, git_dir, normalize};

const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);
const WORKTREE_DEBOUNCE: Duration = Duration::from_secs(1);
/// Steady worktree churn (a log file being appended) still refreshes at this interval instead of
/// holding the debounce open forever.
const MAX_WAIT: Duration = Duration::from_secs(3);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitChanged {
    root: String,
}

type Registry<W> = HashMap<String, (usize, W)>;

#[derive(Default)]
pub struct GitWatches {
    // Dropping a watcher closes its event channel, which ends its debounce thread.
    watchers: Mutex<Registry<RecommendedWatcher>>,
}

/// Where a repo's metadata lives. A linked worktree keeps `HEAD` and `index` in its own git dir
/// and shares refs through the common dir.
#[derive(Debug, PartialEq)]
struct GitDirs {
    git_dir: PathBuf,
    common_dir: PathBuf,
}

fn resolve_dirs(root: &Path) -> Result<GitDirs, String> {
    let git = git_dir(&root.join(".git"))
        .filter(|g| g.is_dir())
        .ok_or_else(|| format!("not a git repo: {}", display(root)))?;
    let common_dir = fs::read_to_string(git.join("commondir"))
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .map(|t| git.join(t))
        .unwrap_or_else(|| git.clone());
    Ok(GitDirs {
        git_dir: git,
        common_dir,
    })
}

fn is_lock(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "lock")
}

/// Git replaces `HEAD`, `index`, and ref files by renaming a `*.lock` over them, so the lock
/// files themselves are noise and the final name is what signals a change.
fn is_relevant_path(path: &Path, refs_dir: &Path) -> bool {
    if is_lock(path) {
        return false;
    }
    if path.starts_with(refs_dir) {
        return true;
    }
    matches!(
        path.file_name().and_then(OsStr::to_str),
        Some("HEAD" | "index" | "packed-refs")
    )
}

/// Decides which changes refresh the pane and how long each waits, caching one parsed
/// `.gitignore` per folder until that file itself changes.
struct Classifier {
    root: PathBuf,
    dirs: GitDirs,
    refs_dir: PathBuf,
    exclude: Gitignore,
    global: Gitignore,
    folders: HashMap<PathBuf, Option<Gitignore>>,
}

impl Classifier {
    fn new(root: PathBuf, dirs: GitDirs) -> Self {
        let refs_dir = dirs.common_dir.join("refs");
        let exclude = Gitignore::new(dirs.common_dir.join("info").join("exclude")).0;
        Self {
            root,
            dirs,
            refs_dir,
            exclude,
            global: Gitignore::global().0,
            folders: HashMap::new(),
        }
    }

    /// A watcher error usually means the OS dropped events in a burst, so it refreshes too.
    fn delay(&mut self, event: &notify::Result<notify::Event>) -> Option<Duration> {
        let Ok(event) = event else {
            return Some(WORKTREE_DEBOUNCE);
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return None;
        }
        event.paths.iter().filter_map(|p| self.path_delay(p)).min()
    }

    fn path_delay(&mut self, path: &Path) -> Option<Duration> {
        if path.starts_with(&self.dirs.git_dir) || path.starts_with(&self.dirs.common_dir) {
            return is_relevant_path(path, &self.refs_dir).then_some(WATCH_DEBOUNCE);
        }
        let rel = path.strip_prefix(&self.root).ok()?;
        if rel.as_os_str().is_empty() || rel.components().any(|c| c.as_os_str() == ".git") {
            return None;
        }
        if path.file_name() == Some(OsStr::new(".gitignore")) {
            if let Some(parent) = path.parent() {
                self.folders.remove(parent);
            }
        }
        (!self.is_ignored(path, rel)).then_some(WORKTREE_DEBOUNCE)
    }

    /// Deeper `.gitignore` files win over shallower ones, then `info/exclude`, then the global
    /// excludes file. Each matcher gets a path relative to its own folder.
    fn is_ignored(&mut self, path: &Path, rel: &Path) -> bool {
        let is_dir = path.is_dir();
        let mut folder = path.parent();
        while let Some(dir) = folder {
            let Ok(sub) = path.strip_prefix(dir) else {
                break;
            };
            let matcher = self.folders.entry(dir.to_path_buf()).or_insert_with(|| {
                let file = dir.join(".gitignore");
                file.is_file().then(|| Gitignore::new(file).0)
            });
            if let Some(m) = matcher {
                match m.matched_path_or_any_parents(sub, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            if dir == self.root {
                break;
            }
            folder = dir.parent();
        }
        [&self.exclude, &self.global]
            .into_iter()
            .find_map(|m| match m.matched_path_or_any_parents(rel, is_dir) {
                Match::Ignore(_) => Some(true),
                Match::Whitelist(_) => Some(false),
                Match::None => None,
            })
            .unwrap_or(false)
    }
}

fn key_for(root: &Path) -> String {
    display(root).to_lowercase()
}

fn acquire<W>(
    map: &mut Registry<W>,
    key: String,
    make: impl FnOnce() -> Result<W, String>,
) -> Result<(), String> {
    if let Some((count, _)) = map.get_mut(&key) {
        *count += 1;
        return Ok(());
    }
    map.insert(key, (1, make()?));
    Ok(())
}

fn release<W>(map: &mut Registry<W>, key: &str) {
    if let Some((count, _)) = map.get_mut(key) {
        if *count > 1 {
            *count -= 1;
        } else {
            map.remove(key);
        }
    }
}

fn start_watcher(
    app: AppHandle,
    root: String,
    normalized: PathBuf,
    dirs: GitDirs,
) -> Result<RecommendedWatcher, String> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    let refs_dir = dirs.common_dir.join("refs");
    let mut watch = |path: &Path, mode: RecursiveMode| {
        watcher
            .watch(path, mode)
            .map_err(|e| format!("{}: {e}", display(path)))
    };
    watch(&normalized, RecursiveMode::Recursive)?;
    // A linked worktree's metadata lives outside its folder.
    if !dirs.git_dir.starts_with(&normalized) {
        watch(&dirs.git_dir, RecursiveMode::NonRecursive)?;
    }
    if refs_dir.is_dir() && !refs_dir.starts_with(&normalized) {
        watch(&refs_dir, RecursiveMode::Recursive)?;
    }
    if dirs.common_dir != dirs.git_dir && !dirs.common_dir.starts_with(&normalized) {
        watch(&dirs.common_dir, RecursiveMode::NonRecursive)?;
    }
    let mut classifier = Classifier::new(normalized, dirs);
    thread::spawn(move || {
        // (first relevant event, emit deadline). Irrelevant events (objects, ignored paths)
        // never extend the deadline, so a build cannot starve a metadata refresh.
        let mut pending: Option<(Instant, Instant)> = None;
        loop {
            let ev = match pending {
                None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                Some((_, due)) => rx.recv_timeout(due.saturating_duration_since(Instant::now())),
            };
            match ev {
                Ok(ev) => {
                    let Some(delay) = classifier.delay(&ev) else {
                        continue;
                    };
                    let now = Instant::now();
                    let first = pending.map_or(now, |(first, _)| first);
                    pending = Some((first, (now + delay).min(first + MAX_WAIT)));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    pending = None;
                    if app
                        .emit("git://changed", GitChanged { root: root.clone() })
                        .is_err()
                    {
                        return;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
    Ok(watcher)
}

#[tauri::command]
pub fn git_watch(app: AppHandle, state: State<'_, GitWatches>, root: String) -> Result<(), String> {
    let normalized = normalize(&root)?;
    let dirs = resolve_dirs(&normalized)?;
    let mut map = state.watchers.lock().unwrap();
    acquire(&mut map, key_for(&normalized), || {
        start_watcher(app, root, normalized.clone(), dirs)
            .inspect_err(|e| eprintln!("git watch failed: {e}"))
    })
}

#[tauri::command]
pub fn git_unwatch(state: State<'_, GitWatches>, root: String) -> Result<(), String> {
    let normalized = normalize(&root)?;
    release(&mut state.watchers.lock().unwrap(), &key_for(&normalized));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bashboard-gitwatch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dot_git_folder_is_its_own_common_dir() {
        let root = temp_dir("folder");
        fs::create_dir_all(root.join(".git")).unwrap();
        let dirs = resolve_dirs(&root).unwrap();
        assert_eq!(dirs.git_dir, root.join(".git"));
        assert_eq!(dirs.common_dir, dirs.git_dir);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_git_dir_is_an_error() {
        let root = temp_dir("none");
        assert!(resolve_dirs(&root).unwrap_err().contains("not a git repo"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn worktree_file_with_relative_gitdir_and_commondir() {
        let base = temp_dir("relative");
        let main_git = base.join("main").join(".git");
        let wt_git = main_git.join("worktrees").join("wt");
        fs::create_dir_all(&wt_git).unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        let dirs = resolve_dirs(&wt).unwrap();
        assert_eq!(dirs.git_dir, wt.join("../main/.git/worktrees/wt"));
        assert_eq!(dirs.common_dir, dirs.git_dir.join("../.."));
        assert!(dirs.common_dir.join("worktrees").is_dir());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn worktree_file_with_absolute_gitdir() {
        let base = temp_dir("absolute");
        let wt_git = base.join("elsewhere").join("wtgit");
        fs::create_dir_all(&wt_git).unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", display(&wt_git))).unwrap();
        let dirs = resolve_dirs(&wt).unwrap();
        assert_eq!(dirs.git_dir, wt_git);
        assert_eq!(dirs.common_dir, wt_git);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn event_filter_keeps_head_index_packed_refs_and_refs() {
        let refs = Path::new("/r/.git/refs");
        assert!(is_relevant_path(Path::new("/r/.git/HEAD"), refs));
        assert!(is_relevant_path(Path::new("/r/.git/index"), refs));
        assert!(is_relevant_path(Path::new("/r/.git/packed-refs"), refs));
        assert!(is_relevant_path(Path::new("/r/.git/refs/heads/main"), refs));
        assert!(!is_relevant_path(Path::new("/r/.git/index.lock"), refs));
        assert!(!is_relevant_path(Path::new("/r/.git/HEAD.lock"), refs));
        assert!(!is_relevant_path(
            Path::new("/r/.git/refs/heads/main.lock"),
            refs
        ));
        assert!(!is_relevant_path(Path::new("/r/.git/COMMIT_EDITMSG"), refs));
        assert!(!is_relevant_path(
            Path::new("/r/.git/objects/ab/cdef"),
            refs
        ));
    }

    fn classifier(root: &Path) -> Classifier {
        fs::create_dir_all(root.join(".git").join("refs")).unwrap();
        Classifier::new(root.to_path_buf(), resolve_dirs(root).unwrap())
    }

    fn modify(path: PathBuf) -> notify::Result<notify::Event> {
        Ok(notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Any)).add_path(path))
    }

    #[test]
    fn access_events_are_ignored() {
        let root = temp_dir("access");
        let mut c = classifier(&root);
        let access = notify::Event::new(EventKind::Access(notify::event::AccessKind::Any))
            .add_path(root.join(".git").join("HEAD"));
        assert_eq!(c.delay(&Ok(access)), None);
        assert_eq!(
            c.delay(&modify(root.join(".git").join("HEAD"))),
            Some(WATCH_DEBOUNCE)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn worktree_edits_count_unless_ignored() {
        let root = temp_dir("worktree");
        let mut c = classifier(&root);
        fs::write(root.join(".gitignore"), "target/\n*.log\n!keep.log\n").unwrap();
        fs::create_dir_all(root.join("target").join("debug")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        let mut delay = |rel: &str| c.delay(&modify(root.join(rel)));
        assert_eq!(delay("src/main.rs"), Some(WORKTREE_DEBOUNCE));
        assert_eq!(delay("target/debug/app.exe"), None);
        assert_eq!(delay("src/run.log"), None);
        assert_eq!(delay("keep.log"), Some(WORKTREE_DEBOUNCE));
        assert_eq!(delay(".git/objects/ab/cdef"), None);
        assert_eq!(delay("vendor/lib/.git/HEAD"), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nested_gitignore_applies_and_reloads() {
        let root = temp_dir("nested");
        let mut c = classifier(&root);
        fs::create_dir_all(root.join("web")).unwrap();
        fs::write(root.join("web").join(".gitignore"), "dist/\n").unwrap();
        let dist = || modify(root.join("web").join("dist").join("app.js"));
        assert_eq!(c.delay(&dist()), None);
        fs::write(root.join("web").join(".gitignore"), "").unwrap();
        assert_eq!(
            c.delay(&modify(root.join("web").join(".gitignore"))),
            Some(WORKTREE_DEBOUNCE)
        );
        assert_eq!(c.delay(&dist()), Some(WORKTREE_DEBOUNCE));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn watcher_errors_refresh() {
        let root = temp_dir("error");
        let mut c = classifier(&root);
        assert_eq!(
            c.delay(&Err(notify::Error::generic("overflow"))),
            Some(WORKTREE_DEBOUNCE)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn watchers_are_reference_counted() {
        let mut map: Registry<u8> = HashMap::new();
        let mut made = 0;
        for _ in 0..2 {
            acquire(&mut map, "a".into(), || {
                made += 1;
                Ok(0)
            })
            .unwrap();
        }
        assert_eq!(made, 1);
        release(&mut map, "a");
        assert!(map.contains_key("a"));
        release(&mut map, "a");
        assert!(map.is_empty());
        release(&mut map, "a");
        assert!(acquire(&mut map, "b".into(), || Err("no".into())).is_err());
        assert!(map.is_empty());
    }

    #[test]
    fn keys_ignore_case() {
        assert_eq!(
            key_for(Path::new("C:\\Repo\\App")),
            key_for(Path::new("c:\\repo\\app"))
        );
    }
}
