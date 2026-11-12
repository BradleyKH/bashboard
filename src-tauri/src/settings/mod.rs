//! User settings (design section 3.6 and 8): lenient JSONC loading, built-in keybindings
//! layered under the user's entries, and a hot-reload watcher.

mod file;
mod keybindings;
mod model;
mod parse;
mod watch;

use std::{
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use notify::RecommendedWatcher;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use file::{edit_settings_file, ensure_default_file, load, reload, settings_path, FILE_NAME};
use keybindings::edit_keybindings_text;
use watch::watch_file;
use crate::lock::LockExt;

pub(crate) use keybindings::normalize_chord;
#[cfg(test)]
pub use keybindings::default_keybindings;
pub use keybindings::KeybindingOp;
pub use model::*;
pub use parse::expand_env;

pub struct SettingsState {
    current: Mutex<(Settings, Vec<String>)>,
    // Held only so the watcher lives as long as the app.
    watcher: Mutex<Option<RecommendedWatcher>>,
    first_run: AtomicBool,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            current: Mutex::new((Settings::default(), Vec::new())),
            watcher: Mutex::new(None),
            first_run: AtomicBool::new(false),
        }
    }
}

impl SettingsState {
    /// Snapshot of the effective settings (keybindings already merged).
    pub fn current(&self) -> Settings {
        self.current.lock_or_recover().0.clone()
    }

    fn payload(&self) -> SettingsPayload {
        let g = self.current.lock_or_recover();
        SettingsPayload {
            settings: g.0.clone(),
            warnings: g.1.clone(),
            first_run: self.first_run.load(Ordering::Relaxed),
        }
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, SettingsState>) -> SettingsPayload {
    state.payload()
}

/// Changes one value in the file. The watcher picks up the write and emits
/// `settings://changed`, so the front end hears about it the same way as a hand edit.
#[tauri::command]
pub fn settings_set(app: AppHandle, path: Vec<String>, value: Value) -> Result<(), String> {
    edit_settings_file(&app, |text| crate::settings_edit::set_value(text, &path, &value))
}

/// Applies keybinding ops to the file's `keybindings` array, leaving the rest of the file as
/// written, and returns the raw array as it was so Undo can send it back with `replaceAll`. The
/// watcher's `settings://changed` delivers the result to the front end.
#[tauri::command]
pub fn settings_keybindings_edit(app: AppHandle, ops: Vec<KeybindingOp>) -> Result<Vec<Value>, String> {
    let mut previous = Vec::new();
    edit_settings_file(&app, |text| {
        let (next, prev) = edit_keybindings_text(text, &ops)?;
        previous = prev;
        Ok(next)
    })?;
    Ok(previous)
}

/// Opens the settings file in the user's default editor, creating it first if missing.
#[tauri::command]
pub fn settings_open_file(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = settings_path(&app).ok_or("no config directory")?;
    ensure_default_file(&file).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Creates the default file if missing, loads it into state, and starts the watcher.
pub fn init(app: &AppHandle) {
    let Some(path) = settings_path(app) else {
        eprintln!("settings: no config directory, using defaults");
        return;
    };
    if let Err(e) = crate::config_dir::seed_dev_file(app, FILE_NAME) {
        eprintln!("settings: could not seed the dev settings file: {e}");
    }
    // A dev file seeded from the installed app counts as existing: that user has already set up.
    let created = match ensure_default_file(&path) {
        Ok(created) => created,
        Err(e) => {
            eprintln!("settings: could not write default file: {e}");
            false
        }
    };
    let state = app.state::<SettingsState>();
    state.first_run.store(created, Ordering::Relaxed);
    *state.current.lock_or_recover() = load(&path);

    let Some(dir) = path.parent().map(Path::to_path_buf) else {
        return;
    };
    let app = app.clone();
    let reload_path = path.clone();
    let on_change = move || {
        let state = app.state::<SettingsState>();
        let next = reload(&reload_path, &state.current());
        *state.current.lock_or_recover() = next;
        let _ = app.emit("settings://changed", state.payload());
    };
    match watch_file(&path, on_change) {
        Ok(watcher) => *state.watcher.lock_or_recover() = Some(watcher),
        Err(e) => eprintln!("settings: could not watch {}: {e}", dir.display()),
    }
}
