//! Workspace, favorites, named layouts, and repo pins persistence (design section 3.7). The core stores
//! each file's JSON verbatim and never inspects it; the front end owns the shape and repairs bad
//! data.

use std::{
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

const WORKSPACE_FILE: &str = "workspace.json";
const FAVORITES_FILE: &str = "favorites.json";
const LAYOUTS_FILE: &str = "layouts.json";
const REPOS_FILE: &str = "repos.json";

/// Files the watcher reloads and the event each one emits.
const WATCHED: &[(&str, &str)] = &[
    (FAVORITES_FILE, "favorites://changed"),
    (LAYOUTS_FILE, "layouts://changed"),
    (REPOS_FILE, "repos://changed"),
];

/// Missing files and invalid JSON both read as `None`; the latter is logged.
fn load_file(path: &Path) -> Option<Value> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("workspace: could not read {}: {e}", path.display());
            return None;
        }
    };
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("workspace: {} is not valid JSON ({e})", path.display());
            None
        }
    }
}

/// Writes `<name>.tmp` then renames it over the target, so a crash never leaves a torn file.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn save_file(path: &Path, data: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    write_atomic(path, text.as_bytes())
}

fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = crate::config_dir::config_dir(app).ok_or("no config directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
pub fn workspace_load(app: AppHandle) -> Result<Option<Value>, String> {
    Ok(load_file(&config_file(&app, WORKSPACE_FILE)?))
}

#[tauri::command]
pub fn workspace_save(app: AppHandle, data: Value) -> Result<(), String> {
    save_file(&config_file(&app, WORKSPACE_FILE)?, &data)
}

#[tauri::command]
pub fn favorites_load(app: AppHandle) -> Result<Option<Value>, String> {
    Ok(load_file(&config_file(&app, FAVORITES_FILE)?))
}

#[tauri::command]
pub fn favorites_save(app: AppHandle, data: Value) -> Result<(), String> {
    save_file(&config_file(&app, FAVORITES_FILE)?, &data)
}

#[tauri::command]
pub fn layouts_load(app: AppHandle) -> Result<Option<Value>, String> {
    Ok(load_file(&config_file(&app, LAYOUTS_FILE)?))
}

#[tauri::command]
pub fn layouts_save(app: AppHandle, data: Value) -> Result<(), String> {
    save_file(&config_file(&app, LAYOUTS_FILE)?, &data)
}

#[tauri::command]
pub fn repos_load(app: AppHandle) -> Result<Option<Value>, String> {
    Ok(load_file(&config_file(&app, REPOS_FILE)?))
}

#[tauri::command]
pub fn repos_save(app: AppHandle, data: Value) -> Result<(), String> {
    save_file(&config_file(&app, REPOS_FILE)?, &data)
}

/// Path of a scratch pad's file. The id alphabet excludes separators and dots, so the result
/// can never leave `<dir>/scratch`.
fn scratch_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    let ok = (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !ok {
        return Err(format!("invalid scratch id: {id:?}"));
    }
    Ok(dir.join("scratch").join(format!("{id}.txt")))
}

fn scratch_write(dir: &Path, id: &str, text: &str) -> Result<(), String> {
    write_atomic(&scratch_path(dir, id)?, text.as_bytes())
}

fn scratch_read(dir: &Path, id: &str) -> Result<String, String> {
    match std::fs::read_to_string(scratch_path(dir, id)?) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn scratch_remove(dir: &Path, id: &str) -> Result<(), String> {
    match std::fs::remove_file(scratch_path(dir, id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn config_root(app: &AppHandle) -> Result<PathBuf, String> {
    crate::config_dir::config_dir(app).ok_or_else(|| "no config directory".to_string())
}

#[tauri::command]
pub fn scratch_save(app: AppHandle, id: String, text: String) -> Result<(), String> {
    scratch_write(&config_root(&app)?, &id, &text)
}

#[tauri::command]
pub fn scratch_load(app: AppHandle, id: String) -> Result<String, String> {
    scratch_read(&config_root(&app)?, &id)
}

#[tauri::command]
pub fn scratch_delete(app: AppHandle, id: String) -> Result<(), String> {
    scratch_remove(&config_root(&app)?, &id)
}

/// Asks for a destination in the native save dialog and writes the text there. `None` means the
/// dialog was cancelled.
#[tauri::command]
pub async fn scratch_save_as(app: AppHandle, text: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // The blocking dialog call must stay off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_file_name("scratch.txt")
            .add_filter("Text", &["txt"])
            .add_filter("All files", &["*"])
            .blocking_save_file();
        let Some(picked) = picked else { return Ok(None) };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Default)]
pub struct WorkspaceState {
    // Held only so the watcher lives as long as the app.
    watcher: Mutex<Option<RecommendedWatcher>>,
}

/// Watches the config directory and emits `favorites://changed`, `layouts://changed`, or
/// `repos://changed` with the reloaded file.
pub fn init(app: &AppHandle) {
    let Some(dir) = config_file(app, FAVORITES_FILE).ok().and_then(|p| p.parent().map(Path::to_path_buf)) else {
        return eprintln!("workspace: no config directory, favorites, layouts, and repos will not hot reload");
    };
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    // Watch the directory: editors save by replacing the file, which drops a file-level watch.
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => return eprintln!("workspace: watcher unavailable: {e}"),
    };
    if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        return eprintln!("workspace: could not watch {}: {e}", dir.display());
    }
    *app.state::<WorkspaceState>().watcher.lock().unwrap() = Some(watcher);

    let app = app.clone();
    thread::spawn(move || {
        let touched = |ev: &notify::Result<notify::Event>, set: &mut [bool]| {
            let Ok(e) = ev else { return };
            for p in &e.paths {
                if let Some(i) = WATCHED.iter().position(|(name, _)| p.file_name().is_some_and(|n| n == *name)) {
                    set[i] = true;
                }
            }
        };
        while let Ok(ev) = rx.recv() {
            let mut changed = [false; WATCHED.len()];
            touched(&ev, &mut changed);
            if !changed.contains(&true) {
                continue;
            }
            // Coalesce the burst of events a single save produces.
            while let Ok(ev) = rx.recv_timeout(Duration::from_millis(100)) {
                touched(&ev, &mut changed);
            }
            for (&(name, event), _) in WATCHED.iter().zip(changed).filter(|(_, c)| *c) {
                let _ = app.emit(event, load_file(&dir.join(name)));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-ws-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn save_then_load_round_trips_and_leaves_no_tmp() {
        let dir = temp_dir("rt");
        let path = dir.join("nested").join(WORKSPACE_FILE);
        let data = json!({ "version": 1, "terminals": [{ "key": "a", "cwd": "C:/x" }] });
        save_file(&path, &data).unwrap();
        assert_eq!(load_file(&path), Some(data));
        assert!(!dir.join("nested").join("workspace.json.tmp").exists());
        let newer = json!([1, 2, 3]);
        save_file(&path, &newer).unwrap();
        assert_eq!(load_file(&path), Some(newer));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_loads_as_none() {
        let dir = temp_dir("missing");
        assert_eq!(load_file(&dir.join(FAVORITES_FILE)), None);
    }

    #[test]
    fn invalid_json_loads_as_none() {
        let dir = temp_dir("bad");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FAVORITES_FILE);
        std::fs::write(&path, "{ nope").unwrap();
        assert_eq!(load_file(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scratch_round_trips_missing_loads_empty_and_delete_is_idempotent() {
        let dir = temp_dir("scratch");
        assert_eq!(scratch_read(&dir, "abc-1").unwrap(), "");
        scratch_write(&dir, "abc-1", "hello
world").unwrap();
        assert_eq!(scratch_read(&dir, "abc-1").unwrap(), "hello
world");
        assert!(!dir.join("scratch").join("abc-1.txt.tmp").exists());
        scratch_remove(&dir, "abc-1").unwrap();
        scratch_remove(&dir, "abc-1").unwrap();
        assert_eq!(scratch_read(&dir, "abc-1").unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scratch_ids_outside_the_alphabet_are_refused() {
        let dir = temp_dir("scratch-ids");
        let long = "a".repeat(65);
        for id in ["../x", "a/b", "a.txt", "", long.as_str()] {
            assert!(scratch_write(&dir, id, "x").is_err(), "{id:?}");
            assert!(scratch_read(&dir, id).is_err(), "{id:?}");
            assert!(scratch_remove(&dir, id).is_err(), "{id:?}");
        }
        assert!(scratch_path(&dir, &"a".repeat(64)).is_ok());
        assert!(!dir.exists());
    }
}
