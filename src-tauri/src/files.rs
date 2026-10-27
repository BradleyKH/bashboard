//! Repo detection and the Files pane's file commands (design section 3.8).
//!
//! Every path must be absolute and is normalized before use. Modified times cross the boundary
//! as integer epoch milliseconds from `modified_ms`, so a time read by one command compares
//! equal in another. Errors the front end acts on start with a fixed prefix: `binary:`,
//! `tooLarge:`, `conflict:`, and `exists:`.

use std::{
    collections::HashMap,
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{State, ipc::Channel};

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES: usize = 8 * 1024;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(200);

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub(crate) root: String,
    pub(crate) is_git: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    text: String,
    modified: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    modified: u64,
}

/// Rejects relative paths and resolves `.` and `..` segments, so a path cannot name somewhere
/// other than what it reads as.
pub(crate) fn normalize(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("not an absolute path: {path}"));
    }
    std::path::absolute(p).map_err(|e| format!("{path}: {e}"))
}

pub(crate) fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn modified_ms(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// The git directory a `.git` entry points at: itself, or the `gitdir:` target of a worktree's
/// `.git` file (relative to the folder holding it).
pub(crate) fn git_dir(dot_git: &Path) -> Option<PathBuf> {
    let meta = fs::metadata(dot_git).ok()?;
    if meta.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    let text = fs::read_to_string(dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    Some(dot_git.parent()?.join(target))
}

/// `ref: refs/heads/<name>` gives `<name>`; a detached HEAD gives the short hash.
fn branch_from_head(head: &str) -> Option<String> {
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref:") {
        let r = r.trim();
        return Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string());
    }
    let is_hash = head.len() >= 7 && head.bytes().all(|b| b.is_ascii_hexdigit());
    is_hash.then(|| head[..7].to_string())
}

pub(crate) fn find_repo(path: &str) -> Result<RepoInfo, String> {
    let start = normalize(path)?;
    for dir in start.ancestors() {
        let dot_git = dir.join(".git");
        if fs::symlink_metadata(&dot_git).is_err() {
            continue;
        }
        let branch = git_dir(&dot_git)
            .and_then(|g| fs::read_to_string(g.join("HEAD")).ok())
            .and_then(|h| branch_from_head(&h));
        return Ok(RepoInfo {
            root: display(dir),
            is_git: true,
            branch,
        });
    }
    Ok(RepoInfo {
        root: display(&start),
        is_git: false,
        branch: None,
    })
}

fn list_dir(dir: &str) -> Result<Vec<Entry>, String> {
    let dir = normalize(dir)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|e| format!("{}: {e}", display(&dir)))? {
        let Ok(item) = item else { continue };
        // Follow links so a linked folder lists as a folder; a broken link falls back to the
        // link itself.
        let Ok(meta) = fs::metadata(item.path()).or_else(|_| item.metadata()) else {
            continue;
        };
        let is_dir = meta.is_dir();
        entries.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            modified: modified_ms(&meta),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

fn read_text(path: &str) -> Result<TextFile, String> {
    let path = normalize(path)?;
    let name = display(&path);
    let file = File::open(&path).map_err(|e| format!("{name}: {e}"))?;
    // Taken before reading, so a write that races the read leaves a newer time on disk and the
    // next save is refused rather than overwriting it.
    let meta = file.metadata().map_err(|e| format!("{name}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {name}"));
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!("tooLarge: {name} is over 2 MiB"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{name}: {e}"))?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(format!("tooLarge: {name} is over 2 MiB"));
    }
    if bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0) {
        return Err(format!("binary: {name} is not a text file"));
    }
    Ok(TextFile {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        modified: modified_ms(&meta),
    })
}

fn write_text(path: &str, text: &str, expected_modified: u64) -> Result<Written, String> {
    let path = normalize(path)?;
    let name = display(&path);
    let meta = fs::metadata(&path).map_err(|e| format!("{name}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {name}"));
    }
    if modified_ms(&meta) != expected_modified {
        return Err(format!("conflict: {name} changed on disk"));
    }
    crate::workspace::write_atomic(&path, text.as_bytes())?;
    let meta = fs::metadata(&path).map_err(|e| format!("{name}: {e}"))?;
    Ok(Written {
        modified: modified_ms(&meta),
    })
}

/// Returns the moved file's new path.
fn move_file(path: &str, to_dir: &str) -> Result<String, String> {
    let from = normalize(path)?;
    let to_dir = normalize(to_dir)?;
    if !fs::metadata(&from).is_ok_and(|m| m.is_file()) {
        return Err(format!("not a file: {}", display(&from)));
    }
    if !to_dir.is_dir() {
        return Err(format!("not a folder: {}", display(&to_dir)));
    }
    let file_name = from
        .file_name()
        .ok_or_else(|| format!("no file name: {}", display(&from)))?;
    let to = to_dir.join(file_name);
    if fs::symlink_metadata(&to).is_ok() {
        return Err(format!("exists: {} already exists", display(&to)));
    }
    match fs::rename(&from, &to) {
        Ok(()) => {}
        // A rename cannot cross drives; copy, then remove the original only once the copy is whole.
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            fs::copy(&from, &to).map_err(|e| format!("{}: {e}", display(&to)))?;
            fs::remove_file(&from).map_err(|e| format!("{}: {e}", display(&from)))?;
        }
        Err(e) => return Err(format!("{}: {e}", display(&from))),
    }
    Ok(display(&to))
}

#[tauri::command]
pub async fn repo_root(path: String) -> Result<RepoInfo, String> {
    find_repo(&path)
}

#[tauri::command]
pub async fn fs_list(dir: String) -> Result<Vec<Entry>, String> {
    list_dir(&dir)
}

#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<TextFile, String> {
    read_text(&path)
}

#[tauri::command]
pub async fn fs_write_text(
    path: String,
    text: String,
    expected_modified: u64,
) -> Result<Written, String> {
    write_text(&path, &text, expected_modified)
}

#[tauri::command]
pub async fn fs_move(path: String, to_dir: String) -> Result<String, String> {
    move_file(&path, &to_dir)
}

#[derive(Default)]
pub struct FilesState {
    next_id: AtomicU32,
    // Dropping a watcher closes its event channel, which ends its debounce thread.
    watchers: Mutex<HashMap<u32, RecommendedWatcher>>,
}

/// Watches one folder, not recursively, and calls `notify` once per burst of events, after
/// `WATCH_DEBOUNCE` of quiet.
fn watch_dir(
    dir: &Path,
    notify: impl Fn() -> bool + Send + 'static,
) -> Result<RecommendedWatcher, String> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("{}: {e}", display(dir)))?;
    let relevant = |ev: &notify::Result<notify::Event>| !matches!(ev, Ok(e) if matches!(e.kind, EventKind::Access(_)));
    thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            if !relevant(&ev) {
                continue;
            }
            loop {
                match rx.recv_timeout(WATCH_DEBOUNCE) {
                    Ok(_) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            if !notify() {
                return;
            }
        }
    });
    Ok(watcher)
}

#[tauri::command]
pub fn fs_watch(
    state: State<'_, FilesState>,
    dir: String,
    on_change: Channel<()>,
) -> Result<u32, String> {
    let dir = normalize(&dir)?;
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", display(&dir)));
    }
    let watcher = watch_dir(&dir, move || on_change.send(()).is_ok())?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.watchers.lock().unwrap().insert(id, watcher);
    Ok(id)
}

#[tauri::command]
pub fn fs_unwatch(state: State<'_, FilesState>, id: u32) {
    state.watchers.lock().unwrap().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bashboard-files-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(p: &Path) -> String {
        display(p)
    }

    #[test]
    fn root_found_from_a_nested_folder_with_a_git_directory() {
        let dir = temp_dir("gitdir");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let nested = dir.join("src").join("deep");
        fs::create_dir_all(&nested).unwrap();
        let info = find_repo(&s(&nested)).unwrap();
        assert_eq!(
            info,
            RepoInfo {
                root: s(&dir),
                is_git: true,
                branch: Some("main".into())
            }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn root_found_from_a_worktree_git_file_relative_and_absolute() {
        let dir = temp_dir("worktree");
        let wt_git = dir.join("main").join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&wt_git).unwrap();
        fs::write(wt_git.join("HEAD"), "ref: refs/heads/feature/x\n").unwrap();

        let rel = dir.join("wt-rel");
        fs::create_dir_all(rel.join("sub")).unwrap();
        fs::write(rel.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        let info = find_repo(&s(&rel.join("sub"))).unwrap();
        assert_eq!(
            info,
            RepoInfo {
                root: s(&rel),
                is_git: true,
                branch: Some("feature/x".into())
            }
        );

        let abs = dir.join("wt-abs");
        fs::create_dir_all(&abs).unwrap();
        fs::write(abs.join(".git"), format!("gitdir: {}\n", s(&wt_git))).unwrap();
        let info = find_repo(&s(&abs)).unwrap();
        assert_eq!(info.branch.as_deref(), Some("feature/x"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detached_head_gives_the_short_hash() {
        assert_eq!(
            branch_from_head("0123456789abcdef0123456789abcdef01234567\n").as_deref(),
            Some("0123456")
        );
        assert_eq!(
            branch_from_head("ref: refs/heads/main").as_deref(),
            Some("main")
        );
        assert_eq!(branch_from_head("garbage"), None);
    }

    #[test]
    fn a_folder_in_no_repo_is_its_own_root() {
        let dir = temp_dir("norepo");
        let info = find_repo(&s(&dir)).unwrap();
        // The temp folder could sit inside some repo on an odd machine; only assert when not.
        if !info.is_git {
            assert_eq!(
                info,
                RepoInfo {
                    root: s(&dir),
                    is_git: false,
                    branch: None
                }
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_puts_folders_first_then_files_by_name() {
        let dir = temp_dir("list");
        fs::create_dir_all(dir.join("zeta")).unwrap();
        fs::write(dir.join("b.txt"), "bb").unwrap();
        fs::write(dir.join("A.txt"), "a").unwrap();
        fs::create_dir_all(dir.join("alpha")).unwrap();
        let entries = list_dir(&s(&dir)).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["alpha", "zeta", "A.txt", "b.txt"]);
        assert!(entries[0].is_dir && !entries[2].is_dir);
        assert_eq!(entries[3].size, 2);
        assert!(entries[3].modified > 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_refuses_binary_and_oversized_files() {
        let dir = temp_dir("read");
        let bin = dir.join("x.bin");
        fs::write(&bin, b"abc\0def").unwrap();
        assert!(read_text(&s(&bin)).unwrap_err().starts_with("binary:"));

        let big = dir.join("big.txt");
        fs::write(&big, vec![b'a'; MAX_TEXT_BYTES as usize + 1]).unwrap();
        assert!(read_text(&s(&big)).unwrap_err().starts_with("tooLarge:"));

        let exact = dir.join("exact.txt");
        fs::write(&exact, vec![b'a'; MAX_TEXT_BYTES as usize]).unwrap();
        assert_eq!(
            read_text(&s(&exact)).unwrap().text.len(),
            MAX_TEXT_BYTES as usize
        );

        // A NUL past the probe window does not make a file binary.
        let late = dir.join("late.txt");
        let mut bytes = vec![b'a'; BINARY_PROBE_BYTES];
        bytes.push(0);
        fs::write(&late, bytes).unwrap();
        assert!(read_text(&s(&late)).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_decodes_invalid_utf8_lossily() {
        let dir = temp_dir("lossy");
        let f = dir.join("a.txt");
        fs::write(&f, b"hi \xff there").unwrap();
        assert_eq!(read_text(&s(&f)).unwrap().text, "hi \u{fffd} there");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_in_a_plain_folder_then_refused_after_the_file_changes() {
        let dir = temp_dir("write");
        let f = dir.join("notes.txt");
        fs::write(&f, "one").unwrap();
        let read = read_text(&s(&f)).unwrap();
        let written = write_text(&s(&f), "two", read.modified).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "two");
        assert!(!dir.join("notes.txt.tmp").exists());
        assert_eq!(read_text(&s(&f)).unwrap().modified, written.modified);

        let earlier = SystemTime::now() - Duration::from_secs(60);
        File::options()
            .write(true)
            .open(&f)
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        let err = write_text(&s(&f), "three", written.modified).unwrap_err();
        assert!(err.starts_with("conflict:"), "{err}");
        assert_eq!(fs::read_to_string(&f).unwrap(), "two");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_refused_for_a_missing_file() {
        let dir = temp_dir("write-missing");
        assert!(write_text(&s(&dir.join("nope.txt")), "x", 0).is_err());
        assert!(!dir.join("nope.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_refused_over_an_existing_name() {
        let dir = temp_dir("move");
        let dest = dir.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dir.join("a.txt"), "src").unwrap();
        fs::write(dest.join("a.txt"), "dest").unwrap();
        let err = move_file(&s(&dir.join("a.txt")), &s(&dest)).unwrap_err();
        assert!(err.starts_with("exists:"), "{err}");
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "dest");

        fs::write(dir.join("b.txt"), "b").unwrap();
        let moved = move_file(&s(&dir.join("b.txt")), &s(&dest)).unwrap();
        assert_eq!(moved, s(&dest.join("b.txt")));
        assert!(!dir.join("b.txt").exists());

        assert!(
            move_file(&s(&dest), &s(&dir)).is_err(),
            "folders are not moved"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dot_dot_segments_are_resolved() {
        let dir = temp_dir("dotdot");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.txt"), "a").unwrap();
        let via = format!(
            "{}{}sub{}..{}a.txt",
            s(&dir),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        assert_eq!(normalize(&via).unwrap(), dir.join("a.txt"));
        assert_eq!(read_text(&via).unwrap().text, "a");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn dot_dot_resolves_with_forward_slashes() {
        assert_eq!(normalize("C:/a/b/../c").unwrap(), PathBuf::from(r"C:\a\c"));
    }

    #[test]
    fn relative_paths_are_rejected() {
        for p in ["a.txt", "../x", "sub/dir", ""] {
            assert!(normalize(p).is_err(), "{p:?}");
            assert!(read_text(p).is_err(), "{p:?}");
            assert!(list_dir(p).is_err(), "{p:?}");
            assert!(find_repo(p).is_err(), "{p:?}");
        }
    }

    #[test]
    fn watch_fires_once_per_burst() {
        let dir = temp_dir("watch");
        let (tx, rx) = mpsc::channel();
        let watcher = watch_dir(&dir, move || tx.send(()).is_ok()).unwrap();
        for i in 0..5 {
            fs::write(dir.join(format!("{i}.txt")), "x").unwrap();
        }
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(
            rx.recv_timeout(Duration::from_millis(600)).is_err(),
            "burst coalesced"
        );
        drop(watcher);
        let _ = fs::remove_dir_all(&dir);
    }
}
