//! User settings (design section 3.6 and 8): lenient JSONC loading, built-in keybindings
//! layered under the user's entries, and a hot-reload watcher.

use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Mutex, mpsc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

const FILE_NAME: &str = "settings.json";
pub const DEFAULT_GIT_BASH_PATH: &str = r"C:\Program Files\Git\bin\bash.exe";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shell {
    pub path: String,
    pub args: Vec<String>,
    pub starting_directory: String,
    /// Profile id normal splits run; see `profiles.rs`.
    pub default_profile: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Font {
    pub family: String,
    pub size: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scrim {
    pub opacity: f64,
    pub blur_px: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backdrop {
    pub animate: bool,
    pub max_fps: u32,
    /// Generations per second.
    pub speed: f64,
    pub capacity: u32,
    pub mutation_rate: f64,
    pub lineage_threads: bool,
    pub orbit: bool,
    /// Divides the camera's home distance.
    pub zoom: f64,
    pub waiting_pulse: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub visible_on_start: bool,
    pub peek_on_waiting: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restore {
    pub enabled: bool,
    pub resume_claude: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Containers {
    pub enabled: bool,
}

/// The zoom a new pane of each kind starts at; the zoom buttons save it (docs/design.md 4.12, 4.13).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextZoom {
    pub files_list: f64,
    pub file_preview: f64,
    pub git_diff: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    /// One of `EDITOR_IDS`.
    pub preferred: String,
    /// When non-empty, replaces the editor's built-in arguments; see docs/design.md section 3.12.
    pub command: String,
}

/// Ids `editor.preferred` accepts (docs/design.md section 3.12).
pub const EDITOR_IDS: [&str; 7] = ["zed", "vscode", "cursor", "visualStudio", "notepadpp", "sublime", "default"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keybinding {
    pub keys: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub shell: Shell,
    pub font: Font,
    pub scrim: Scrim,
    pub backdrop: Backdrop,
    pub scrollback: u32,
    pub dashboard: Dashboard,
    pub restore: Restore,
    pub editor: Editor,
    pub containers: Containers,
    pub text_zoom: TextZoom,
    pub keybindings: Vec<Keybinding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    pub settings: Settings,
    pub warnings: Vec<String>,
    /// True when this launch created settings.json (docs/design.md section 4.17).
    pub first_run: bool,
}

fn kb(keys: &str, action: &str, direction: Option<&str>, input: Option<&str>) -> Keybinding {
    Keybinding {
        keys: keys.into(),
        action: action.into(),
        direction: direction.map(Into::into),
        input: input.map(Into::into),
        index: None,
    }
}

fn kb_index(keys: &str, action: &str, index: u32) -> Keybinding {
    Keybinding { index: Some(index), ..kb(keys, action, None, None) }
}

pub fn default_keybindings() -> Vec<Keybinding> {
    let mut v = vec![
        kb("ctrl+right", "splitRight", None, None),
        kb("ctrl+down", "splitDown", None, None),
        kb("alt+shift+d", "splitAuto", None, None),
        kb("ctrl+w", "closePane", None, None),
    ];
    for d in ["left", "right", "up", "down"] {
        v.push(kb(&format!("alt+{d}"), "moveFocus", Some(d), None));
    }
    for d in ["left", "right", "up", "down"] {
        v.push(kb(&format!("alt+shift+{d}"), "resizePane", Some(d), None));
    }
    v.extend([
        kb("ctrl+shift+f", "find", None, None),
        kb("ctrl+c", "copy", None, None),
        kb("ctrl+shift+c", "copy", None, None),
        kb("ctrl+v", "paste", None, None),
        kb("ctrl+shift+v", "paste", None, None),
        kb("shift+enter", "sendInput", None, Some("\u{1b}\r")),
        kb("ctrl+shift+s", "toggleDashboard", None, None),
        kb("ctrl+shift+b", "cycleScrim", None, None),
        kb("ctrl+shift+l", "toggleBackdrop", None, None),
        kb("ctrl+shift+m", "collapsePane", None, None),
        kb("ctrl+shift+z", "togglePaneZoom", None, None),
        kb("ctrl+shift+o", "openFavorite", None, None),
        kb("ctrl+shift+p", "openLayout", None, None),
        kb("alt+shift+t", "splitWithProfile", None, None),
        kb("ctrl+shift+t", "newTab", None, None),
        kb("ctrl+shift+n", "newScratch", None, None),
        kb("ctrl+shift+e", "openFiles", None, None),
        kb("ctrl+shift+g", "openGit", None, None),
        kb("ctrl+shift+h", "openSearch", None, None),
        kb("ctrl+shift+w", "closeTab", None, None),
        kb("ctrl+tab", "nextTab", None, None),
        kb("ctrl+shift+tab", "prevTab", None, None),
        kb("f1", "showHelp", None, None),
        kb("ctrl+,", "openSettings", None, None),
        kb("f11", "toggleFullscreen", None, None),
        kb("ctrl+alt+9", "switchToLastTab", None, None),
        kb("ctrl+=", "increaseFontSize", None, None),
        kb("ctrl++", "increaseFontSize", None, None),
        kb("ctrl+-", "decreaseFontSize", None, None),
        kb("ctrl+0", "resetFontSize", None, None),
    ]);
    for n in 1..=8u32 {
        v.push(kb_index(&format!("ctrl+alt+{n}"), "switchToTab", n));
    }
    v
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            shell: Shell {
                path: DEFAULT_GIT_BASH_PATH.into(),
                args: vec!["--login".into(), "-i".into()],
                starting_directory: "%USERPROFILE%".into(),
                default_profile: crate::profiles::GIT_BASH.into(),
            },
            font: Font {
                family: "JetBrainsMono Nerd Font Mono, Cascadia Mono".into(),
                size: 14.0,
            },
            scrim: Scrim { opacity: 0.5, blur_px: 0.0 },
            backdrop: Backdrop {
                animate: false,
                max_fps: 20,
                speed: 10.0,
                capacity: 1000,
                mutation_rate: 0.2,
                lineage_threads: false,
                orbit: true,
                zoom: 2.0,
                waiting_pulse: false,
            },
            scrollback: 10000,
            dashboard: Dashboard { visible_on_start: true, peek_on_waiting: true },
            restore: Restore { enabled: true, resume_claude: true },
            editor: Editor { preferred: "default".into(), command: String::new() },
            containers: Containers { enabled: true },
            text_zoom: TextZoom { files_list: 1.0, file_preview: 1.0, git_diff: 1.0 },
            keybindings: default_keybindings(),
        }
    }
}

/// Expands `%VAR%` references; unknown variables and stray `%` are left as written.
pub fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => match std::env::var(&after[..end]) {
                Ok(val) => {
                    out.push_str(&val);
                    rest = &after[end + 1..];
                }
                Err(_) => {
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Modifier order and case do not matter: `shift+Ctrl+V` equals `ctrl+shift+v`.
fn normalize_chord(keys: &str) -> String {
    // A trailing "+" is the plus key itself ("ctrl++").
    let (mods, plus) = match keys.trim().strip_suffix('+') {
        Some(rest) if rest.is_empty() || rest.ends_with('+') => (rest.trim_end_matches('+'), true),
        _ => (keys, false),
    };
    let mut parts: Vec<String> = mods.split('+').map(|p| p.trim().to_lowercase()).collect();
    let key = if plus { "+".to_string() } else { parts.pop().unwrap_or_default() };
    if plus && parts.last().is_some_and(|p| p.is_empty()) {
        parts.pop();
    }
    parts.sort();
    parts.push(key);
    parts.join("+")
}

fn get<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(root, |v, k| v.get(*k))
}

fn pick<T>(
    root: &Value,
    path: &[&str],
    warnings: &mut Vec<String>,
    parse: impl Fn(&Value) -> Option<T>,
    default: T,
) -> T {
    match get(root, path) {
        None => default,
        Some(v) => parse(v).unwrap_or_else(|| {
            warnings.push(format!("{}: invalid value, using default", path.join(".")));
            default
        }),
    }
}

fn parse_keybindings(root: &Value, warnings: &mut Vec<String>) -> Vec<Keybinding> {
    let mut merged = default_keybindings();
    let Some(v) = root.get("keybindings") else {
        return merged;
    };
    let Some(entries) = v.as_array() else {
        warnings.push("keybindings: invalid value, using defaults".into());
        return merged;
    };
    for (i, e) in entries.iter().enumerate() {
        let (Some(keys), Some(action)) = (
            e.get("keys").and_then(Value::as_str),
            e.get("action").and_then(Value::as_str),
        ) else {
            warnings.push(format!("keybindings[{i}]: needs string \"keys\" and \"action\", dropped"));
            continue;
        };
        let mut opt = |name: &str| match e.get(name) {
            None => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                warnings.push(format!("keybindings[{i}].{name}: invalid value, ignored"));
                None
            }
        };
        let direction = opt("direction");
        let input = opt("input");
        let index = match e.get("index") {
            None => None,
            Some(v) => match v.as_u64().and_then(|n| u32::try_from(n).ok()) {
                Some(n) => Some(n),
                None => {
                    warnings.push(format!("keybindings[{i}].index: invalid value, ignored"));
                    None
                }
            },
        };
        let entry = Keybinding { keys: keys.into(), action: action.into(), direction, input, index };
        let chord = normalize_chord(keys);
        merged.retain(|d| normalize_chord(&d.keys) != chord);
        if action != "unbound" {
            merged.push(entry);
        }
    }
    merged
}

/// Never fails: bad input degrades to defaults and is reported in the warnings.
#[cfg(test)]
fn parse_settings(text: &str) -> (Settings, Vec<String>) {
    try_parse_settings(text).unwrap_or_else(|e| (Settings::default(), vec![format!("{e}, using defaults")]))
}

/// Errs only when the file as a whole is unusable; a bad field degrades to its default.
fn try_parse_settings(text: &str) -> Result<(Settings, Vec<String>), String> {
    let mut stripped = String::new();
    let parsed = json_comments::StripComments::new(text.as_bytes())
        .read_to_string(&mut stripped)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str::<Value>(&stripped).map_err(|e| e.to_string()));
    let root = match parsed {
        Ok(v @ Value::Object(_)) => v,
        Ok(_) => return Err("settings file must be a JSON object".into()),
        Err(e) => return Err(format!("settings file is not valid JSON ({e})")),
    };

    let d = Settings::default();
    let mut w = Vec::new();
    let string = |v: &Value| v.as_str().map(String::from);
    let number = |v: &Value| v.as_f64();
    let boolean = |v: &Value| v.as_bool();

    let shell = Shell {
        path: pick(&root, &["shell", "path"], &mut w, string, d.shell.path),
        args: pick(
            &root,
            &["shell", "args"],
            &mut w,
            |v| v.as_array()?.iter().map(string).collect::<Option<Vec<_>>>(),
            d.shell.args,
        ),
        starting_directory: pick(
            &root,
            &["shell", "startingDirectory"],
            &mut w,
            string,
            d.shell.starting_directory,
        ),
        default_profile: pick(
            &root,
            &["shell", "defaultProfile"],
            &mut w,
            |v| v.as_str().filter(|s| crate::profiles::PROFILE_IDS.contains(s)).map(String::from),
            d.shell.default_profile,
        ),
    };
    let font = Font {
        family: pick(&root, &["font", "family"], &mut w, string, d.font.family),
        size: pick(&root, &["font", "size"], &mut w, |v| number(v).filter(|n| *n > 0.0), d.font.size),
    };
    let scrim = Scrim {
        opacity: pick(
            &root,
            &["scrim", "opacity"],
            &mut w,
            |v| number(v).filter(|n| (0.0..=1.0).contains(n)),
            d.scrim.opacity,
        ),
        blur_px: pick(
            &root,
            &["scrim", "blurPx"],
            &mut w,
            |v| number(v).filter(|n| *n >= 0.0),
            d.scrim.blur_px,
        ),
    };
    let backdrop = Backdrop {
        animate: pick(&root, &["backdrop", "animate"], &mut w, boolean, d.backdrop.animate),
        // The frame loop clamps each delta to 1/20 s, so a cap below 20 would slow the simulation.
        max_fps: pick(
            &root,
            &["backdrop", "maxFps"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n == 0 || (20..=240).contains(n)),
            d.backdrop.max_fps,
        ),
        speed: pick(
            &root,
            &["backdrop", "speed"],
            &mut w,
            |v| number(v).filter(|n| (0.25..=12.0).contains(n)),
            d.backdrop.speed,
        ),
        // The organism layer draws at most 12000, which leaves room for the tide's swell above 5000.
        capacity: pick(
            &root,
            &["backdrop", "capacity"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| (300..=5000).contains(n)),
            d.backdrop.capacity,
        ),
        mutation_rate: pick(
            &root,
            &["backdrop", "mutationRate"],
            &mut w,
            |v| number(v).filter(|n| (0.0..=4.0).contains(n)),
            d.backdrop.mutation_rate,
        ),
        lineage_threads: pick(
            &root,
            &["backdrop", "lineageThreads"],
            &mut w,
            boolean,
            d.backdrop.lineage_threads,
        ),
        orbit: pick(&root, &["backdrop", "orbit"], &mut w, boolean, d.backdrop.orbit),
        zoom: pick(
            &root,
            &["backdrop", "zoom"],
            &mut w,
            |v| number(v).filter(|n| (0.5..=3.0).contains(n)),
            d.backdrop.zoom,
        ),
        waiting_pulse: pick(&root, &["backdrop", "waitingPulse"], &mut w, boolean, d.backdrop.waiting_pulse),
    };
    let scrollback = pick(
        &root,
        &["scrollback"],
        &mut w,
        |v| v.as_u64().and_then(|n| u32::try_from(n).ok()),
        d.scrollback,
    );
    let dashboard = Dashboard {
        visible_on_start: pick(
            &root,
            &["dashboard", "visibleOnStart"],
            &mut w,
            boolean,
            d.dashboard.visible_on_start,
        ),
        peek_on_waiting: pick(
            &root,
            &["dashboard", "peekOnWaiting"],
            &mut w,
            boolean,
            d.dashboard.peek_on_waiting,
        ),
    };
    let restore = Restore {
        enabled: pick(&root, &["restore", "enabled"], &mut w, boolean, d.restore.enabled),
        resume_claude: pick(&root, &["restore", "resumeClaude"], &mut w, boolean, d.restore.resume_claude),
    };
    let editor = Editor {
        preferred: pick(
            &root,
            &["editor", "preferred"],
            &mut w,
            |v| v.as_str().filter(|s| EDITOR_IDS.contains(s)).map(String::from),
            d.editor.preferred,
        ),
        command: pick(&root, &["editor", "command"], &mut w, string, d.editor.command),
    };
    let containers = Containers {
        enabled: pick(&root, &["containers", "enabled"], &mut w, boolean, d.containers.enabled),
    };
    // Matches ZOOM_LEVELS in src/textZoom.ts.
    let zoom = |v: &Value| number(v).filter(|n| (0.5..=3.0).contains(n));
    let text_zoom = TextZoom {
        files_list: pick(&root, &["textZoom", "filesList"], &mut w, zoom, d.text_zoom.files_list),
        file_preview: pick(&root, &["textZoom", "filePreview"], &mut w, zoom, d.text_zoom.file_preview),
        git_diff: pick(&root, &["textZoom", "gitDiff"], &mut w, zoom, d.text_zoom.git_diff),
    };
    let keybindings = parse_keybindings(&root, &mut w);

    Ok((
        Settings {
            shell,
            font,
            scrim,
            backdrop,
            scrollback,
            dashboard,
            restore,
            editor,
            containers,
            text_zoom,
            keybindings,
        },
        w,
    ))
}

/// Pretty JSONC with an empty `keybindings` array so later changes to the built-in
/// defaults reach existing files.
fn default_file_text() -> String {
    let mut s = Settings::default();
    s.keybindings.clear();
    let json = serde_json::to_string_pretty(&s).expect("default settings serialize");
    json.replace(
        "  \"editor\": {",
        "  // zed, vscode, cursor, visualStudio, notepadpp, sublime, or default (the file's default
  // app). A non-empty command replaces it, with {path} and {line} filled in.
  \"editor\": {",
    )
    .replace(
        "  \"containers\": {",
        "  // false hides the Containers section; the Containers pane still opens on request (4.16).
  \"containers\": {",
    )
    .replace(
        "  \"textZoom\": {",
        "  // The zoom new Files and Git panes start at, from 0.5 to 3; their zoom buttons save it.
  \"textZoom\": {",
    )
    .replace(
        "  \"keybindings\": []",
        "  // Entries add to or override the default keybindings listed in docs/design.md\n  // section 4.5. An entry with \"action\": \"unbound\" removes the default for its keys.\n  \"keybindings\": []",
    )
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    crate::config_dir::config_dir(app).map(|d| d.join(FILE_NAME))
}

/// Returns true when it created the file.
fn ensure_default_file(path: &Path) -> std::io::Result<bool> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, default_file_text())?;
    Ok(true)
}

fn read(path: &Path) -> Result<(Settings, Vec<String>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("could not read settings file ({e})"))?;
    try_parse_settings(&text)
}

fn load(path: &Path) -> (Settings, Vec<String>) {
    read(path).unwrap_or_else(|e| (Settings::default(), vec![format!("{e}, using defaults")]))
}

/// A mid-session save that leaves the file unusable keeps the running settings, so a typo
/// does not reset every pane to the defaults.
fn reload(path: &Path, previous: &Settings) -> (Settings, Vec<String>) {
    read(path).unwrap_or_else(|e| (previous.clone(), vec![format!("{e}, keeping the previous settings")]))
}

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
        self.current.lock().unwrap().0.clone()
    }

    fn payload(&self) -> SettingsPayload {
        let g = self.current.lock().unwrap();
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
    // Serializes the read-modify-write so rapid calls (slider drags, repeated hotkeys)
    // cannot both read the same text and lose one of the edits.
    static WRITE_LOCK: Mutex<()> = Mutex::new(());
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = settings_path(&app).ok_or("no config directory")?;
    ensure_default_file(&file).map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&file).map_err(|e| format!("could not read settings file ({e})"))?;
    let next = crate::settings_edit::set_value(&text, &path, &value)?;
    crate::hook_install::write_atomic(&file, &next)
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
    *state.current.lock().unwrap() = load(&path);

    let Some(dir) = path.parent().map(Path::to_path_buf) else {
        return;
    };
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    // Watch the directory: editors save by replacing the file, which drops a file-level watch.
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => return eprintln!("settings: watcher unavailable: {e}"),
    };
    if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        return eprintln!("settings: could not watch {}: {e}", dir.display());
    }
    *state.watcher.lock().unwrap() = Some(watcher);

    let app = app.clone();
    thread::spawn(move || {
        let relevant = |ev: &notify::Result<notify::Event>| {
            ev.as_ref()
                .is_ok_and(|e| e.paths.iter().any(|p| p.file_name().is_some_and(|n| n == FILE_NAME)))
        };
        while let Ok(ev) = rx.recv() {
            if !relevant(&ev) {
                continue;
            }
            // Coalesce the burst of events a single save produces.
            while rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
            let state = app.state::<SettingsState>();
            let next = reload(&path, &state.current());
            *state.current.lock().unwrap() = next;
            let _ = app.emit("settings://changed", state.payload());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find<'a>(s: &'a Settings, keys: &str) -> Option<&'a Keybinding> {
        s.keybindings.iter().find(|k| k.keys == keys)
    }

    #[test]
    fn empty_object_is_defaults() {
        let (s, w) = parse_settings("{}");
        assert_eq!(s, Settings::default());
        assert!(w.is_empty());
    }

    #[test]
    fn partial_file_keeps_other_defaults() {
        let (s, w) = parse_settings(r#"{ "font": { "size": 18 }, "scrollback": 500 }"#);
        assert_eq!(s.font.size, 18.0);
        assert_eq!(s.scrollback, 500);
        assert_eq!(s.font.family, Settings::default().font.family);
        assert_eq!(s.scrim, Settings::default().scrim);
        assert!(w.is_empty());
    }

    #[test]
    fn invalid_values_fall_back_with_warning() {
        let (s, w) = parse_settings(
            r#"{ "font": { "size": 0 }, "scrim": { "opacity": 2 }, "scrollback": -1, "shell": { "args": [1] } }"#,
        );
        let d = Settings::default();
        assert_eq!(s.font.size, d.font.size);
        assert_eq!(s.scrim.opacity, d.scrim.opacity);
        assert_eq!(s.scrollback, d.scrollback);
        assert_eq!(s.shell.args, d.shell.args);
        for field in ["font.size", "scrim.opacity", "scrollback", "shell.args"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn backdrop_values_parse_and_out_of_range_fps_falls_back() {
        let (s, w) = parse_settings(r#"{ "backdrop": { "animate": true, "maxFps": 0 } }"#);
        assert_eq!(s.backdrop, Backdrop { animate: true, max_fps: 0, ..Settings::default().backdrop });
        assert!(w.is_empty());
        for bad in ["10", "241", "-1", "30.5", "\"60\""] {
            let (s, w) = parse_settings(&format!(r#"{{ "backdrop": {{ "maxFps": {bad} }} }}"#));
            assert_eq!(s.backdrop.max_fps, Settings::default().backdrop.max_fps, "{bad}");
            assert!(w.iter().any(|m| m.starts_with("backdrop.maxFps")), "{bad}: {w:?}");
        }
    }

    #[test]
    fn simulation_values_parse_and_out_of_range_ones_fall_back() {
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "speed": 0.5, "capacity": 800, "mutationRate": 1.5, "lineageThreads": true, "orbit": false, "zoom": 2.5, "waitingPulse": true } }"#,
        );
        assert_eq!((s.backdrop.speed, s.backdrop.capacity, s.backdrop.mutation_rate, s.backdrop.zoom), (0.5, 800, 1.5, 2.5));
        assert!(s.backdrop.lineage_threads && !s.backdrop.orbit && s.backdrop.waiting_pulse);
        assert!(w.is_empty(), "{w:?}");
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "speed": 0.1, "capacity": 5001, "mutationRate": -1, "zoom": 4, "waitingPulse": "yes" } }"#,
        );
        let d = Settings::default().backdrop;
        assert_eq!((s.backdrop.speed, s.backdrop.capacity, s.backdrop.mutation_rate), (d.speed, d.capacity, d.mutation_rate));
        assert_eq!((s.backdrop.zoom, s.backdrop.waiting_pulse), (d.zoom, d.waiting_pulse));
        for field in ["backdrop.speed", "backdrop.capacity", "backdrop.mutationRate", "backdrop.zoom", "backdrop.waitingPulse"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn restore_values_parse_and_invalid_ones_fall_back() {
        let (s, w) = parse_settings(r#"{ "restore": { "enabled": false, "resumeClaude": false } }"#);
        assert_eq!(s.restore, Restore { enabled: false, resume_claude: false });
        assert!(w.is_empty());
        let (s, w) = parse_settings(r#"{ "restore": { "enabled": "no", "resumeClaude": 0 } }"#);
        assert_eq!(s.restore, Settings::default().restore);
        for field in ["restore.enabled", "restore.resumeClaude"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn restore_defaults_to_enabled_and_is_in_default_file() {
        let d = Settings::default();
        assert_eq!(d.restore, Restore { enabled: true, resume_claude: true });
        let text = default_file_text();
        assert!(text.contains("\"restore\"") && text.contains("\"resumeClaude\""));
    }

    #[test]
    fn containers_enabled_parses_and_invalid_value_falls_back() {
        let (s, w) = parse_settings(r#"{ "containers": { "enabled": false } }"#);
        assert_eq!(s.containers, Containers { enabled: false });
        assert!(w.is_empty(), "{w:?}");
        let (s, w) = parse_settings(r#"{ "containers": { "enabled": "no" } }"#);
        assert_eq!(s.containers, Settings::default().containers);
        assert!(w.iter().any(|m| m.starts_with("containers.enabled")), "missing warning: {w:?}");
    }

    #[test]
    fn text_zoom_parses_and_out_of_range_value_falls_back() {
        let (s, w) = parse_settings(r#"{ "textZoom": { "filesList": 1.25, "filePreview": 0.5, "gitDiff": 3 } }"#);
        assert_eq!(s.text_zoom, TextZoom { files_list: 1.25, file_preview: 0.5, git_diff: 3.0 });
        assert!(w.is_empty(), "{w:?}");
        let (s, w) = parse_settings(r#"{ "textZoom": { "gitDiff": 4 } }"#);
        assert_eq!(s.text_zoom, Settings::default().text_zoom);
        assert!(w.iter().any(|m| m.starts_with("textZoom.gitDiff")), "missing warning: {w:?}");
        assert!(default_file_text().contains("\"textZoom\""));
    }

    #[test]
    fn containers_defaults_to_enabled_and_is_in_default_file() {
        assert_eq!(Settings::default().containers, Containers { enabled: true });
        assert!(default_file_text().contains("\"containers\""));
    }

    #[test]
    fn collapse_and_favorite_chords_are_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+m").map(|k| k.action.as_str()), Some("collapsePane"));
        assert_eq!(find(&s, "ctrl+shift+o").map(|k| k.action.as_str()), Some("openFavorite"));
    }

    #[test]
    fn zoom_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+z").map(|k| k.action.as_str()), Some("togglePaneZoom"));
    }

    #[test]
    fn layout_and_profile_chords_are_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+p").map(|k| k.action.as_str()), Some("openLayout"));
        assert_eq!(find(&s, "alt+shift+t").map(|k| k.action.as_str()), Some("splitWithProfile"));
        assert_eq!(find(&s, "ctrl+shift+t").map(|k| k.action.as_str()), Some("newTab"));
        assert_eq!(find(&s, "ctrl+shift+n").map(|k| k.action.as_str()), Some("newScratch"));
    }

    #[test]
    fn open_files_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+e").map(|k| k.action.as_str()), Some("openFiles"));
    }

    #[test]
    fn open_git_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+g").map(|k| k.action.as_str()), Some("openGit"));
    }

    #[test]
    fn open_search_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+h").map(|k| k.action.as_str()), Some("openSearch"));
    }

    #[test]
    fn editor_values_parse() {
        assert_eq!(Settings::default().editor, Editor { preferred: "default".into(), command: String::new() });
        for id in EDITOR_IDS {
            let (s, w) = parse_settings(&format!(r#"{{ "editor": {{ "preferred": "{id}" }} }}"#));
            assert_eq!(s.editor.preferred, id);
            assert!(w.is_empty(), "{id}: {w:?}");
        }
        let (s, w) = parse_settings(r#"{ "editor": { "command": "code -g \"{path}:{line}\"" } }"#);
        assert_eq!(s.editor.command, "code -g \"{path}:{line}\"");
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn invalid_editor_values_fall_back_with_warning() {
        let (s, w) = parse_settings(r#"{ "editor": { "preferred": "emacs", "command": 5 } }"#);
        assert_eq!(s.editor, Settings::default().editor);
        for field in ["editor.preferred", "editor.command"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn editor_is_in_default_file() {
        assert!(default_file_text().contains("\"editor\""));
    }

    #[test]
    fn default_profile_parses_and_unknown_one_falls_back() {
        assert_eq!(Settings::default().shell.default_profile, "gitBash");
        let (s, w) = parse_settings(r#"{ "shell": { "defaultProfile": "pwsh" } }"#);
        assert_eq!(s.shell.default_profile, "pwsh");
        assert!(w.is_empty(), "{w:?}");
        for bad in ["\"zsh\"", "\"PWSH\"", "1"] {
            let (s, w) = parse_settings(&format!(r#"{{ "shell": {{ "defaultProfile": {bad} }} }}"#));
            assert_eq!(s.shell.default_profile, "gitBash", "{bad}");
            assert!(w.iter().any(|m| m.starts_with("shell.defaultProfile")), "{bad}: {w:?}");
        }
    }

    #[test]
    fn tab_and_font_chords_are_bound_by_default() {
        let s = Settings::default();
        let action = |k: &str| find(&s, k).map(|b| b.action.as_str());
        assert_eq!(action("ctrl+="), Some("increaseFontSize"));
        assert_eq!(action("ctrl++"), Some("increaseFontSize"));
        assert_eq!(action("ctrl+0"), Some("resetFontSize"));
        assert_eq!(action("ctrl+alt+9"), Some("switchToLastTab"));
        assert_eq!(find(&s, "ctrl+alt+3").and_then(|b| b.index), Some(3));
    }

    #[test]
    fn keybinding_index_is_accepted_when_a_whole_number() {
        let (s, w) = parse_settings(
            r#"{ "keybindings": [ { "keys": "alt+1", "action": "switchToTab", "index": 2 } ] }"#,
        );
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(find(&s, "alt+1").and_then(|b| b.index), Some(2));
        for bad in ["\"2\"", "-1", "1.5"] {
            let (s, w) = parse_settings(&format!(
                r#"{{ "keybindings": [ {{ "keys": "alt+1", "action": "switchToTab", "index": {bad} }} ] }}"#
            ));
            assert_eq!(find(&s, "alt+1").and_then(|b| b.index), None, "{bad}");
            assert!(w.iter().any(|m| m.contains("index")), "{bad}: {w:?}");
        }
    }

    #[test]
    fn help_is_bound_to_f1_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "f1").map(|k| k.action.as_str()), Some("showHelp"));
    }

    #[test]
    fn settings_is_bound_to_ctrl_comma_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+,").map(|k| k.action.as_str()), Some("openSettings"));
    }

    #[test]
    fn backdrop_toggle_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+l").map(|k| k.action.as_str()), Some("toggleBackdrop"));
    }

    #[test]
    fn unknown_keys_ignored() {
        let (s, w) = parse_settings(r#"{ "bogus": 1, "font": { "weight": "bold" } }"#);
        assert_eq!(s, Settings::default());
        assert!(w.is_empty());
    }

    #[test]
    fn comments_accepted() {
        let (s, w) = parse_settings("// top\n{ /* c */ \"scrollback\": 7 // tail\n}");
        assert_eq!(s.scrollback, 7);
        assert!(w.is_empty());
    }

    #[test]
    fn malformed_json_gives_defaults_and_warning() {
        let (s, w) = parse_settings("{ nope");
        assert_eq!(s, Settings::default());
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn bad_keybinding_entry_dropped() {
        let (s, w) = parse_settings(
            r#"{ "keybindings": [ { "keys": "ctrl+k" }, { "keys": "ctrl+j", "action": "find" } ] }"#,
        );
        assert!(find(&s, "ctrl+k").is_none());
        assert!(find(&s, "ctrl+j").is_some());
        assert_eq!(w.len(), 1);
        assert!(w[0].starts_with("keybindings[0]"));
    }

    #[test]
    fn user_entry_overrides_default_chord() {
        let (s, _) =
            parse_settings(r#"{ "keybindings": [ { "keys": "ctrl+right", "action": "splitAuto" } ] }"#);
        let all: Vec<_> = s.keybindings.iter().filter(|k| k.keys == "ctrl+right").collect();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].action, "splitAuto");
        assert_eq!(s.keybindings.len(), default_keybindings().len());
    }

    #[test]
    fn override_ignores_modifier_order_and_case() {
        let (s, _) = parse_settings(
            r#"{ "keybindings": [ { "keys": "shift+Ctrl+V", "action": "sendInput", "input": "x" } ] }"#,
        );
        assert!(find(&s, "ctrl+shift+v").is_none());
        let k = find(&s, "shift+Ctrl+V").unwrap();
        assert_eq!(k.action, "sendInput");
        assert_eq!(s.keybindings.len(), default_keybindings().len());
    }

    #[test]
    fn new_chord_is_added() {
        let (s, _) =
            parse_settings(r#"{ "keybindings": [ { "keys": "ctrl+shift+d", "action": "splitAuto" } ] }"#);
        assert_eq!(s.keybindings.len(), default_keybindings().len() + 1);
        assert!(find(&s, "ctrl+shift+d").is_some());
        assert!(find(&s, "ctrl+w").is_some());
    }

    #[test]
    fn unbound_removes_default() {
        let (s, w) =
            parse_settings(r#"{ "keybindings": [ { "keys": "Ctrl+W", "action": "unbound" } ] }"#);
        assert!(find(&s, "ctrl+w").is_none());
        assert!(s.keybindings.iter().all(|k| k.action != "unbound"));
        assert_eq!(s.keybindings.len(), default_keybindings().len() - 1);
        assert!(w.is_empty());
    }

    #[test]
    fn empty_keybindings_is_exactly_defaults() {
        let (s, _) = parse_settings(r#"{ "keybindings": [] }"#);
        assert_eq!(s.keybindings, default_keybindings());
    }

    #[test]
    fn default_file_parses_back_to_defaults() {
        let text = default_file_text();
        assert!(text.contains("//"));
        let (s, w) = parse_settings(&text);
        assert_eq!(s, Settings::default());
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn ensure_default_file_reports_whether_it_created_the_file() {
        let dir = std::env::temp_dir().join(format!("bashboard-settings-first-{}", std::process::id()));
        let path = dir.join(FILE_NAME);
        assert!(ensure_default_file(&path).unwrap());
        assert!(!ensure_default_file(&path).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn payload_serializes_first_run_in_camel_case() {
        let payload = SettingsPayload { settings: Settings::default(), warnings: Vec::new(), first_run: true };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["firstRun"], true);
        assert!(json.get("first_run").is_none());
    }

    #[test]
    fn default_file_created_in_temp_dir() {
        let dir = std::env::temp_dir().join(format!("bashboard-settings-{}", std::process::id()));
        let path = dir.join("nested").join(FILE_NAME);
        ensure_default_file(&path).unwrap();
        let (s, w) = load(&path);
        assert_eq!(s, Settings::default());
        assert!(w.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_file_falls_back_on_load_and_keeps_previous_on_reload() {
        let dir = std::env::temp_dir().join(format!("bashboard-settings-bad-{}", std::process::id()));
        let path = dir.join(FILE_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let (previous, _) = parse_settings(r#"{ "scrollback": 1234 }"#);
        for text in ["", "{ \"scrollback\": 5", "[1, 2]"] {
            std::fs::write(&path, text).unwrap();
            let (s, w) = load(&path);
            assert_eq!(s, Settings::default(), "{text:?}");
            assert_eq!(w.len(), 1, "{text:?}: {w:?}");
            let (s, w) = reload(&path, &previous);
            assert_eq!(s, previous, "{text:?}");
            assert_eq!(w.len(), 1, "{text:?}: {w:?}");
        }
        std::fs::remove_file(&path).unwrap();
        assert_eq!(load(&path).0, Settings::default());
        assert_eq!(reload(&path, &previous).0, previous);
        std::fs::write(&path, r#"{ "scrollback": 99 }"#).unwrap();
        assert_eq!(reload(&path, &previous).0.scrollback, 99);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expands_env_vars() {
        let var = if std::env::var("USERPROFILE").is_ok() { "USERPROFILE" } else { "HOME" };
        let val = std::env::var(var).unwrap();
        assert_eq!(expand_env(&format!("%{var}%")), val);
        assert_eq!(expand_env(&format!("a/%{var}%/b")), format!("a/{val}/b"));
        assert_eq!(expand_env("%NOPE_NOT_SET_XYZ%"), "%NOPE_NOT_SET_XYZ%");
        assert_eq!(expand_env("50% done"), "50% done");
    }
}
