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
    /// One of `BACKDROP_STYLES`.
    pub style: String,
    pub animate: bool,
    pub max_fps: u32,
    pub capacity: u32,
    pub mutation_rate: f64,
    /// Divides the camera's home distance.
    pub zoom: f64,
    pub waiting_pulse: bool,
    pub matrix: MatrixBackdrop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixBackdrop {
    /// `#rrggbb`, any lightness (the rain is drawn dimmer than the text over it).
    pub color: String,
    pub zoom: f64,
    /// Rain steps per second.
    pub speed: u32,
    /// Scales how often an idle column starts a new drop.
    pub density: f64,
}

/// Ids `backdrop.style` accepts (docs/design.md section 8).
pub const BACKDROP_STYLES: [&str; 3] = ["none", "lights", "matrix"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub visible_on_start: bool,
    pub peek_on_waiting: bool,
    /// One of `DASHBOARD_SIDES`.
    pub side: String,
    pub sections: DashboardSections,
    /// One of `CLOCK_STYLES`.
    pub clock_style: String,
}

pub const DEFAULT_ACCENT: &str = "#4fb3c8";

/// The accent is drawn as text on near-black panes and behind dark text in find highlights; at
/// this WCAG relative luminance both keep at least 4.5:1 contrast. Mirrors src/accent.ts.
const ACCENT_MIN_LUMINANCE: f64 = 0.2;

pub const DEFAULT_CONTENT_TEXT: &str = "#e6e6e6";

/// Content text is read in long stretches, so it must stay well brighter than the dark panes,
/// and brighter than the accent so links and highlights still stand out. Mirrors
/// src/contentText.ts.
const CONTENT_TEXT_MIN_LUMINANCE: f64 = 0.5;

/// Accepts `#rrggbb` (any case) bright enough to read, returned lowercase.
fn parse_accent(s: &str) -> Option<String> {
    parse_bright_hex(s, ACCENT_MIN_LUMINANCE)
}

fn parse_content_text(s: &str) -> Option<String> {
    parse_bright_hex(s, CONTENT_TEXT_MIN_LUMINANCE)
}

/// Accepts `#rrggbb` (any case) of any lightness, returned lowercase.
fn parse_hex(s: &str) -> Option<String> {
    parse_bright_hex(s, 0.0)
}

/// Accepts `#rrggbb` (any case) at or above `min` WCAG relative luminance, returned lowercase.
fn parse_bright_hex(s: &str, min: f64) -> Option<String> {
    let hex = s.strip_prefix('#').filter(|h| h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()))?;
    let channel = |i: usize| {
        let c = f64::from(u8::from_str_radix(&hex[i..i + 2], 16).ok()?) / 255.0;
        Some(if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) })
    };
    let luminance = 0.2126 * channel(0)? + 0.7152 * channel(2)? + 0.0722 * channel(4)?;
    (luminance >= min).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

/// Ids `dashboard.side` accepts (docs/design.md section 4.6).
pub const DASHBOARD_SIDES: [&str; 2] = ["left", "right"];

/// Ids `dashboard.clockStyle` accepts (docs/design.md section 4.6).
pub const CLOCK_STYLES: [&str; 3] = ["both", "time", "binary"];

/// Which dashboard elements show; fields follow the panel's default element order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSections {
    pub favorites: bool,
    pub layouts: bool,
    pub panes: bool,
    pub containers: bool,
    pub external: bool,
    pub system: bool,
    pub clock: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restore {
    pub enabled: bool,
    pub resume_claude: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSettings {
    /// Minutes between background fetches of repos with an open Git pane; 0 turns it off.
    pub auto_fetch_minutes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    /// Shell commands running at least this many seconds mark the terminal done or failed; 0 turns it off.
    pub done_after_seconds: u32,
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
pub const EDITOR_IDS: [&str; 18] = [
    "zed", "vscode", "cursor", "visualStudio", "notepadpp", "sublime", "rider", "intellij",
    "webstorm", "pycharm", "rustrover", "goland", "clion", "phpstorm", "windsurf",
    "vscodeInsiders", "vscodium", "default",
];

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
    /// `#rrggbb`; see `parse_accent`.
    pub accent_color: String,
    /// `#rrggbb`; see `parse_content_text`.
    pub content_text_color: String,
    pub scrim: Scrim,
    pub backdrop: Backdrop,
    pub scrollback: u32,
    pub terminal: Terminal,
    pub dashboard: Dashboard,
    pub restore: Restore,
    pub editor: Editor,
    pub git: GitSettings,
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
        kb("f6", "focusDashboard", None, None),
        kb("ctrl+shift+b", "cycleScrim", None, None),
        kb("ctrl+shift+d", "toggleBackdrop", None, None),
        kb("ctrl+shift+l", "nextAttention", None, None),
        kb("ctrl+shift+m", "collapsePane", None, None),
        kb("ctrl+shift+z", "togglePaneZoom", None, None),
        kb("ctrl+shift+o", "openFavorite", None, None),
        kb("ctrl+shift+r", "openLayout", None, None),
        kb("ctrl+shift+p", "openPalette", None, None),
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
            accent_color: DEFAULT_ACCENT.into(),
            content_text_color: DEFAULT_CONTENT_TEXT.into(),
            scrim: Scrim { opacity: 0.5, blur_px: 0.0 },
            backdrop: Backdrop {
                style: "lights".into(),
                animate: false,
                max_fps: 20,
                capacity: 1000,
                mutation_rate: 0.2,
                zoom: 2.0,
                waiting_pulse: false,
                matrix: MatrixBackdrop { color: "#00ff41".into(), zoom: 1.0, speed: 10, density: 3.0 },
            },
            scrollback: 10000,
            terminal: Terminal { done_after_seconds: 30 },
            dashboard: Dashboard {
                visible_on_start: true,
                peek_on_waiting: true,
                side: "right".into(),
                sections: DashboardSections {
                    favorites: true,
                    layouts: true,
                    panes: true,
                    containers: true,
                    external: true,
                    system: false,
                    clock: false,
                },
                clock_style: "both".into(),
            },
            restore: Restore { enabled: true, resume_claude: true },
            editor: Editor { preferred: "default".into(), command: String::new() },
            git: GitSettings { auto_fetch_minutes: 5 },
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

/// Same aliases as `parseChord` in `src/keymap.ts`, so the file and the front end agree on
/// which entry a chord is.
fn chord_alias(part: String) -> String {
    match part.as_str() {
        "win" => "meta".into(),
        "esc" => "escape".into(),
        "del" => "delete".into(),
        "ins" => "insert".into(),
        _ => part,
    }
}

/// Modifier order, case, and aliases do not matter: `shift+Ctrl+V` equals `ctrl+shift+v`.
fn normalize_chord(keys: &str) -> String {
    // A trailing "+" is the plus key itself ("ctrl++").
    let (mods, plus) = match keys.trim().strip_suffix('+') {
        Some(rest) if rest.is_empty() || rest.ends_with('+') => (rest.trim_end_matches('+'), true),
        _ => (keys, false),
    };
    let mut parts: Vec<String> = mods.split('+').map(|p| chord_alias(p.trim().to_lowercase())).collect();
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

/// One edit to the raw `keybindings` array (docs/design.md section 4.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum KeybindingOp {
    #[serde(rename_all = "camelCase")]
    Bind {
        keys: String,
        action: String,
        #[serde(default)]
        direction: Option<String>,
        #[serde(default)]
        index: Option<u32>,
        #[serde(default)]
        input: Option<String>,
    },
    Unbind { keys: String },
    Reset { keys: String },
    ResetAll,
    /// Writes the raw array back as given, rejected entries included, so Undo after Reset all
    /// restores what the loader ignored as well as the keymap.
    ReplaceAll { entries: Vec<Value> },
}

/// The settings file's root object with comments stripped.
fn parse_root(text: &str) -> Result<Value, String> {
    let mut stripped = String::new();
    let parsed = json_comments::StripComments::new(text.as_bytes())
        .read_to_string(&mut stripped)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str::<Value>(&stripped).map_err(|e| e.to_string()));
    match parsed {
        Ok(v @ Value::Object(_)) => Ok(v),
        Ok(_) => Err("settings file must be a JSON object".into()),
        Err(e) => Err(format!("settings file is not valid JSON ({e})")),
    }
}

/// The file's `keybindings` array as written, rejected entries included. Errs when the array
/// itself is unusable, so an edit never overwrites a value the loader ignored as a whole.
fn raw_keybindings(text: &str) -> Result<Vec<Value>, String> {
    let fix = "; fix it in settings.json before changing keys";
    let root = parse_root(text).map_err(|e| format!("{e}{fix}"))?;
    match root.get("keybindings") {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(_) => Err(format!("\"keybindings\" in settings.json is not a list{fix}")),
    }
}

/// Applies `ops` in order to the raw array. Entries that are not for a touched chord, including
/// entries the loader rejects, keep their place.
fn apply_keybinding_ops(mut entries: Vec<Value>, ops: &[KeybindingOp]) -> Vec<Value> {
    let defaults = default_keybindings();
    let default_for = |chord: &str| defaults.iter().find(|d| normalize_chord(&d.keys) == chord);
    for op in ops {
        let keys = match op {
            KeybindingOp::ResetAll => {
                entries.clear();
                continue;
            }
            KeybindingOp::ReplaceAll { entries: all } => {
                entries = all.clone();
                continue;
            }
            KeybindingOp::Bind { keys, .. }
            | KeybindingOp::Unbind { keys }
            | KeybindingOp::Reset { keys } => keys,
        };
        let chord = normalize_chord(keys);
        entries.retain(|e| e.get("keys").and_then(Value::as_str).is_none_or(|k| normalize_chord(k) != chord));
        match op {
            KeybindingOp::Bind { action, direction, index, input, .. } => {
                let is_default = default_for(&chord).is_some_and(|d| {
                    &d.action == action && &d.direction == direction && &d.index == index && &d.input == input
                });
                if !is_default {
                    let mut e = serde_json::Map::new();
                    e.insert("keys".into(), keys.clone().into());
                    e.insert("action".into(), action.clone().into());
                    if let Some(d) = direction {
                        e.insert("direction".into(), d.clone().into());
                    }
                    if let Some(i) = index {
                        e.insert("index".into(), (*i).into());
                    }
                    if let Some(s) = input {
                        e.insert("input".into(), s.clone().into());
                    }
                    entries.push(Value::Object(e));
                }
            }
            KeybindingOp::Unbind { .. } => {
                if default_for(&chord).is_some() {
                    entries.push(serde_json::json!({ "keys": keys, "action": "unbound" }));
                }
            }
            KeybindingOp::Reset { .. } | KeybindingOp::ResetAll | KeybindingOp::ReplaceAll { .. } => {}
        }
    }
    entries
}

/// Never fails: bad input degrades to defaults and is reported in the warnings.
#[cfg(test)]
fn parse_settings(text: &str) -> (Settings, Vec<String>) {
    try_parse_settings(text).unwrap_or_else(|e| (Settings::default(), vec![format!("{e}, using defaults")]))
}

/// Errs only when the file as a whole is unusable; a bad field degrades to its default.
fn try_parse_settings(text: &str) -> Result<(Settings, Vec<String>), String> {
    let root = parse_root(text)?;

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
    let accent_color = pick(
        &root,
        &["accentColor"],
        &mut w,
        |v| v.as_str().and_then(parse_accent),
        d.accent_color,
    );
    let content_text_color = pick(
        &root,
        &["contentTextColor"],
        &mut w,
        |v| v.as_str().and_then(parse_content_text),
        d.content_text_color,
    );
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
        style: pick(
            &root,
            &["backdrop", "style"],
            &mut w,
            |v| v.as_str().filter(|s| BACKDROP_STYLES.contains(s)).map(String::from),
            d.backdrop.style,
        ),
        animate: pick(&root, &["backdrop", "animate"], &mut w, boolean, d.backdrop.animate),
        // The frame loop clamps each delta to 1/20 s, so a cap below 20 would slow the simulation.
        max_fps: pick(
            &root,
            &["backdrop", "maxFps"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n == 0 || (20..=240).contains(n)),
            d.backdrop.max_fps,
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
        zoom: pick(
            &root,
            &["backdrop", "zoom"],
            &mut w,
            |v| number(v).filter(|n| (0.5..=3.0).contains(n)),
            d.backdrop.zoom,
        ),
        waiting_pulse: pick(&root, &["backdrop", "waitingPulse"], &mut w, boolean, d.backdrop.waiting_pulse),
        matrix: MatrixBackdrop {
            color: pick(
                &root,
                &["backdrop", "matrix", "color"],
                &mut w,
                |v| v.as_str().and_then(parse_hex),
                d.backdrop.matrix.color,
            ),
            zoom: pick(
                &root,
                &["backdrop", "matrix", "zoom"],
                &mut w,
                |v| number(v).filter(|n| (0.5..=3.0).contains(n)),
                d.backdrop.matrix.zoom,
            ),
            speed: pick(
                &root,
                &["backdrop", "matrix", "speed"],
                &mut w,
                |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| (5..=30).contains(n)),
                d.backdrop.matrix.speed,
            ),
            density: pick(
                &root,
                &["backdrop", "matrix", "density"],
                &mut w,
                |v| number(v).filter(|n| (0.25..=4.0).contains(n)),
                d.backdrop.matrix.density,
            ),
        },
    };
    let scrollback = pick(
        &root,
        &["scrollback"],
        &mut w,
        |v| v.as_u64().and_then(|n| u32::try_from(n).ok()),
        d.scrollback,
    );
    let terminal = Terminal {
        done_after_seconds: pick(
            &root,
            &["terminal", "doneAfterSeconds"],
            &mut w,
            |v| v.as_u64().filter(|n| *n <= 86_400).and_then(|n| u32::try_from(n).ok()),
            d.terminal.done_after_seconds,
        ),
    };
    // containers.enabled predates dashboard.sections.containers and still seeds it.
    let containers_default = get(&root, &["containers", "enabled"])
        .and_then(Value::as_bool)
        .unwrap_or(d.dashboard.sections.containers);
    let section = |w: &mut Vec<String>, name: &str, default: bool| {
        pick(&root, &["dashboard", "sections", name], w, boolean, default)
    };
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
        side: pick(
            &root,
            &["dashboard", "side"],
            &mut w,
            |v| v.as_str().filter(|s| DASHBOARD_SIDES.contains(s)).map(String::from),
            d.dashboard.side,
        ),
        sections: DashboardSections {
            favorites: section(&mut w, "favorites", d.dashboard.sections.favorites),
            layouts: section(&mut w, "layouts", d.dashboard.sections.layouts),
            panes: section(&mut w, "panes", d.dashboard.sections.panes),
            containers: section(&mut w, "containers", containers_default),
            external: section(&mut w, "external", d.dashboard.sections.external),
            system: section(&mut w, "system", d.dashboard.sections.system),
            clock: section(&mut w, "clock", d.dashboard.sections.clock),
        },
        clock_style: pick(
            &root,
            &["dashboard", "clockStyle"],
            &mut w,
            |v| v.as_str().filter(|s| CLOCK_STYLES.contains(s)).map(String::from),
            d.dashboard.clock_style,
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
    let git = GitSettings {
        auto_fetch_minutes: pick(
            &root,
            &["git", "autoFetchMinutes"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n <= 1440),
            d.git.auto_fetch_minutes,
        ),
    };
    let keybindings = parse_keybindings(&root, &mut w);

    Ok((
        Settings {
            shell,
            font,
            accent_color,
            content_text_color,
            scrim,
            backdrop,
            scrollback,
            terminal,
            dashboard,
            restore,
            editor,
            git,
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
        "  \"accentColor\":",
        "  // Any #rrggbb bright enough to read on the dark panes; darker colors fall back to the default.
  \"accentColor\":",
    )
    .replace(
        "  \"contentTextColor\":",
        "  // Text in scratch, file preview, and search panes (not terminals). Any #rrggbb at least as
  // bright as #bcbcbc; darker colors fall back to the default.
  \"contentTextColor\":",
    )
    .replace(
        "  \"editor\": {",
        "  // zed, vscode, cursor, visualStudio, notepadpp, sublime, rider, intellij, webstorm,
  // pycharm, rustrover, goland, clion, phpstorm, windsurf, vscodeInsiders, vscodium, or default
  // (the file's default app). A non-empty command replaces it, with {path} and {line} filled in.
  \"editor\": {",
    )
    .replace(
        "  \"terminal\": {",
        "  // Shell commands that run at least this many seconds mark the terminal done, or failed on a
  // nonzero exit, when they finish unseen. 0 turns it off.
  \"terminal\": {",
    )
    .replace(
        "  \"dashboard\": {",
        "  // side is left or right. sections shows or hides each dashboard element; sections.containers
  // also decides whether the kind menu offers a Containers pane (docs/design.md section 4.6).
  \"dashboard\": {",
    )
    .replace(
        "  \"git\": {",
        "  // Minutes between background fetches of repos with an open Git pane; 0 turns it off (3.9).
  \"git\": {",
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

/// Serializes every read-modify-write of the settings file so rapid calls (slider drags,
/// repeated hotkeys, key edits) cannot both read the same text and lose one of the edits.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Reads the settings file (creating it first if missing), applies `edit` to its text, and
/// writes the result back, all under `WRITE_LOCK`.
fn edit_settings_file(
    app: &AppHandle,
    edit: impl FnOnce(&str) -> Result<String, String>,
) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = settings_path(app).ok_or("no config directory")?;
    ensure_default_file(&file).map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&file).map_err(|e| format!("could not read settings file ({e})"))?;
    let next = edit(&text)?;
    crate::hook_install::write_atomic(&file, &next)
}

/// Changes one value in the file. The watcher picks up the write and emits
/// `settings://changed`, so the front end hears about it the same way as a hand edit.
#[tauri::command]
pub fn settings_set(app: AppHandle, path: Vec<String>, value: Value) -> Result<(), String> {
    edit_settings_file(&app, |text| crate::settings_edit::set_value(text, &path, &value))
}

/// The file text with `ops` applied to its raw `keybindings` array, and that array as it was.
fn edit_keybindings_text(text: &str, ops: &[KeybindingOp]) -> Result<(String, Vec<Value>), String> {
    let previous = raw_keybindings(text)?;
    let next = apply_keybinding_ops(previous.clone(), ops);
    Ok((crate::settings_edit::set_array_lines(text, &["keybindings".into()], &next)?, previous))
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
    *state.current.lock().unwrap() = load(&path);

    let Some(dir) = path.parent().map(Path::to_path_buf) else {
        return;
    };
    let app = app.clone();
    let reload_path = path.clone();
    let on_change = move || {
        let state = app.state::<SettingsState>();
        let next = reload(&reload_path, &state.current());
        *state.current.lock().unwrap() = next;
        let _ = app.emit("settings://changed", state.payload());
    };
    match watch_file(&path, on_change) {
        Ok(watcher) => *state.watcher.lock().unwrap() = Some(watcher),
        Err(e) => eprintln!("settings: could not watch {}: {e}", dir.display()),
    }
}

/// Watches `file` and calls `on_change` once per burst of events that could have changed it.
/// The folder is watched rather than the file because a replace (an editor's save, `sed -i`)
/// swaps the file out from under a file-level watch.
fn watch_file(file: &Path, on_change: impl Fn() + Send + 'static) -> notify::Result<RecommendedWatcher> {
    let dir = file.parent().map(Path::to_path_buf).unwrap_or_default();
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    let file = file.to_path_buf();
    thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            if !event_may_touch(&ev, &file) {
                continue;
            }
            // Coalesce the burst of events a single save produces.
            while rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
            on_change();
        }
    });
    Ok(watcher)
}

/// Whether a folder event could mean `file` changed. Errs toward yes, since a spurious reload
/// only re-reads the file while a missed one leaves stale settings until the next save.
/// ReadDirectoryChangesW may name a file by its 8.3 alias (`SETTIN~1.JSO`) or in another case,
/// and a buffer overflow arrives as an event with no paths or with the folder itself as path.
fn event_may_touch(ev: &notify::Result<notify::Event>, file: &Path) -> bool {
    let Ok(ev) = ev else {
        return true;
    };
    if ev.need_rescan() || ev.paths.is_empty() {
        return true;
    }
    let Some(name) = file.file_name().and_then(|n| n.to_str()) else {
        return true;
    };
    let alias_prefix = name
        .split('.')
        .next()
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(6)
        .collect::<String>()
        .to_ascii_uppercase();
    let dir = file.parent();
    ev.paths.iter().any(|p| match p.file_name().and_then(|n| n.to_str()) {
        None => true,
        Some(_) if Some(p.as_path()) == dir => true,
        Some(n) => {
            n.eq_ignore_ascii_case(name)
                || (n.contains('~') && n.to_ascii_uppercase().starts_with(&alias_prefix))
        }
    })
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
    fn accent_color_needs_bright_six_digit_hex() {
        let (s, w) = parse_settings(r##"{ "accentColor": "#A68BFF" }"##);
        assert_eq!(s.accent_color, "#a68bff");
        assert!(w.is_empty());
        for bad in [r##""#1a2b4c""##, r##""#fff""##, r##""teal""##, "12"] {
            let (s, w) = parse_settings(&format!(r#"{{ "accentColor": {bad} }}"#));
            assert_eq!(s.accent_color, DEFAULT_ACCENT, "{bad}");
            assert_eq!(w, vec!["accentColor: invalid value, using default"], "{bad}");
        }
    }

    #[test]
    fn content_text_color_needs_brighter_hex_than_accent() {
        let (s, w) = parse_settings(r##"{ "contentTextColor": "#B5D8DF" }"##);
        assert_eq!(s.content_text_color, "#b5d8df");
        assert!(w.is_empty());
        // #a8b8c8 is the Silver accent: bright enough for an accent, too dim for body text.
        for bad in [r##""#a8b8c8""##, r##""#eee""##, r##""white""##] {
            let (s, w) = parse_settings(&format!(r#"{{ "contentTextColor": {bad} }}"#));
            assert_eq!(s.content_text_color, DEFAULT_CONTENT_TEXT, "{bad}");
            assert_eq!(w, vec!["contentTextColor: invalid value, using default"], "{bad}");
        }
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
    fn backdrop_style_and_matrix_values_parse_and_invalid_ones_fall_back() {
        let d = Settings::default().backdrop;
        let (s, w) = parse_settings(r#"{ "backdrop": { "animate": true } }"#);
        assert_eq!(s.backdrop.style, "lights");
        assert!(w.is_empty(), "{w:?}");

        let (s, w) = parse_settings(
            r##"{ "backdrop": { "style": "matrix", "matrix": { "color": "#102030", "zoom": 2.5, "speed": 25, "density": 2.5 } } }"##,
        );
        assert_eq!(s.backdrop.style, "matrix");
        assert_eq!(s.backdrop.matrix, MatrixBackdrop { color: "#102030".into(), zoom: 2.5, speed: 25, density: 2.5 });
        assert!(w.is_empty(), "{w:?}");
        let (s, w) = parse_settings(r#"{ "backdrop": { "style": "none" } }"#);
        assert_eq!(s.backdrop.style, "none");
        assert!(w.is_empty(), "{w:?}");

        for (path, key, bad) in [
            ("backdrop.style", "style", r#""rain""#),
            ("backdrop.style", "style", "1"),
            ("backdrop.matrix.color", "color", r##""#0f0""##),
            ("backdrop.matrix.color", "color", r##""green""##),
            ("backdrop.matrix.zoom", "zoom", "0.4"),
            ("backdrop.matrix.zoom", "zoom", "3.1"),
            ("backdrop.matrix.speed", "speed", "4"),
            ("backdrop.matrix.speed", "speed", "31"),
            ("backdrop.matrix.speed", "speed", "12.5"),
            ("backdrop.matrix.speed", "speed", "\"20\""),
            ("backdrop.matrix.density", "density", "0.2"),
            ("backdrop.matrix.density", "density", "4.5"),
            ("backdrop.matrix.density", "density", "\"1\""),
        ] {
            let json = if key == "style" {
                format!(r#"{{ "backdrop": {{ "style": {bad} }} }}"#)
            } else {
                format!(r#"{{ "backdrop": {{ "matrix": {{ "{key}": {bad} }} }} }}"#)
            };
            let (s, w) = parse_settings(&json);
            assert_eq!(s.backdrop, d, "{json}");
            assert_eq!(w, vec![format!("{path}: invalid value, using default")], "{json}");
        }
    }

    #[test]
    fn simulation_values_parse_and_out_of_range_ones_fall_back() {
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "capacity": 800, "mutationRate": 1.5, "zoom": 2.5, "waitingPulse": true } }"#,
        );
        assert_eq!((s.backdrop.capacity, s.backdrop.mutation_rate, s.backdrop.zoom), (800, 1.5, 2.5));
        assert!(s.backdrop.waiting_pulse);
        assert!(w.is_empty(), "{w:?}");
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "capacity": 5001, "mutationRate": -1, "zoom": 4, "waitingPulse": "yes" } }"#,
        );
        let d = Settings::default().backdrop;
        assert_eq!((s.backdrop.capacity, s.backdrop.mutation_rate), (d.capacity, d.mutation_rate));
        assert_eq!((s.backdrop.zoom, s.backdrop.waiting_pulse), (d.zoom, d.waiting_pulse));
        for field in ["backdrop.capacity", "backdrop.mutationRate", "backdrop.zoom", "backdrop.waitingPulse"] {
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
    fn legacy_containers_enabled_seeds_the_containers_section() {
        let (s, w) = parse_settings(r#"{ "containers": { "enabled": false } }"#);
        assert!(!s.dashboard.sections.containers);
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn dashboard_sections_containers_wins_over_legacy_key() {
        let (s, w) = parse_settings(
            r#"{ "containers": { "enabled": false }, "dashboard": { "sections": { "containers": true } } }"#,
        );
        assert!(s.dashboard.sections.containers);
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn invalid_legacy_containers_enabled_is_ignored_silently() {
        let (s, w) = parse_settings(r#"{ "containers": { "enabled": "no" } }"#);
        assert!(s.dashboard.sections.containers);
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn default_file_has_no_top_level_containers_key() {
        let v = parse_root(&default_file_text()).expect("default file parses");
        assert!(v.get("containers").is_none());
    }

    #[test]
    fn dashboard_side_parses_and_invalid_values_fall_back() {
        for side in ["left", "right"] {
            let (s, w) = parse_settings(&format!(r#"{{ "dashboard": {{ "side": "{side}" }} }}"#));
            assert_eq!(s.dashboard.side, side);
            assert!(w.is_empty(), "{w:?}");
        }
        for bad in [r#""top""#, "3"] {
            let (s, w) = parse_settings(&format!(r#"{{ "dashboard": {{ "side": {bad} }} }}"#));
            assert_eq!(s.dashboard.side, "right");
            assert!(w.iter().any(|m| m.starts_with("dashboard.side")), "missing warning: {w:?}");
        }
    }

    #[test]
    fn dashboard_sections_defaults_and_partial_parse() {
        let d = Settings::default().dashboard;
        assert_eq!(d.side, "right");
        assert_eq!(
            d.sections,
            DashboardSections {
                favorites: true,
                layouts: true,
                panes: true,
                containers: true,
                external: true,
                system: false,
                clock: false
            }
        );
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "clock": true, "panes": false } } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert!(s.dashboard.sections.clock && !s.dashboard.sections.panes);
        assert!(s.dashboard.sections.favorites && s.dashboard.sections.external);
    }

    #[test]
    fn dashboard_clock_style_parse() {
        assert_eq!(Settings::default().dashboard.clock_style, "both");
        let (s, w) = parse_settings(r#"{ "dashboard": { "clockStyle": "binary" } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s.dashboard.clock_style, "binary");
        let (s, w) = parse_settings(r#"{ "dashboard": { "clockStyle": "analog" } }"#);
        assert_eq!(s.dashboard.clock_style, "both");
        assert!(w.iter().any(|m| m.starts_with("dashboard.clockStyle")), "missing warning: {w:?}");
    }

    #[test]
    fn dashboard_sections_system_parse() {
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "system": true } } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert!(s.dashboard.sections.system);
        assert!(!s.dashboard.sections.clock);
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "system": "yes" } } }"#);
        assert!(!s.dashboard.sections.system);
        assert!(w.iter().any(|m| m.starts_with("dashboard.sections.system")), "missing warning: {w:?}");
    }

    #[test]
    fn invalid_dashboard_section_value_falls_back_with_warning() {
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "layouts": "yes" } } }"#);
        assert!(s.dashboard.sections.layouts);
        assert!(w.iter().any(|m| m.starts_with("dashboard.sections.layouts")), "missing warning: {w:?}");
    }

    #[test]
    fn default_file_lists_dashboard_side_and_sections() {
        let text = default_file_text();
        assert!(text.contains("\"sections\"") && text.contains("\"side\""));
    }

    #[test]
    fn git_auto_fetch_minutes_defaults_to_5_and_is_in_default_file() {
        assert_eq!(Settings::default().git, GitSettings { auto_fetch_minutes: 5 });
        assert!(default_file_text().contains("\"git\""));
    }

    #[test]
    fn git_auto_fetch_minutes_parses_bounds() {
        for n in [0u32, 30, 1440] {
            let (s, w) = parse_settings(&format!(r#"{{ "git": {{ "autoFetchMinutes": {n} }} }}"#));
            assert_eq!(s.git.auto_fetch_minutes, n);
            assert!(w.is_empty(), "{w:?}");
        }
    }

    #[test]
    fn git_auto_fetch_minutes_rejects_invalid_values() {
        for bad in ["-1", "1.5", "\"5\"", "1441"] {
            let (s, w) = parse_settings(&format!(r#"{{ "git": {{ "autoFetchMinutes": {bad} }} }}"#));
            assert_eq!(s.git.auto_fetch_minutes, 5, "{bad}");
            assert_eq!(w.len(), 1, "{bad}: {w:?}");
            assert!(w[0].starts_with("git.autoFetchMinutes"), "{bad}: {w:?}");
        }
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
        assert_eq!(find(&s, "ctrl+shift+r").map(|k| k.action.as_str()), Some("openLayout"));
        assert_eq!(find(&s, "ctrl+shift+p").map(|k| k.action.as_str()), Some("openPalette"));
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
    fn focus_dashboard_is_bound_to_f6_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "f6").map(|k| k.action.as_str()), Some("focusDashboard"));
    }

    #[test]
    fn settings_is_bound_to_ctrl_comma_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+,").map(|k| k.action.as_str()), Some("openSettings"));
    }

    #[test]
    fn backdrop_toggle_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+d").map(|k| k.action.as_str()), Some("toggleBackdrop"));
    }

    #[test]
    fn next_attention_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+l").map(|k| k.action.as_str()), Some("nextAttention"));
    }

    #[test]
    fn terminal_done_after_seconds_defaults_to_30() {
        assert_eq!(Settings::default().terminal, Terminal { done_after_seconds: 30 });
        let (s, w) = parse_settings("{}");
        assert_eq!(s.terminal.done_after_seconds, 30);
        assert!(w.is_empty());
    }

    #[test]
    fn terminal_done_after_seconds_accepts_valid_values() {
        for n in [0u32, 120] {
            let (s, w) = parse_settings(&format!(r#"{{ "terminal": {{ "doneAfterSeconds": {n} }} }}"#));
            assert_eq!(s.terminal.done_after_seconds, n);
            assert!(w.is_empty());
        }
    }

    #[test]
    fn terminal_done_after_seconds_rejects_invalid_values() {
        for bad in ["-1", "1.5", r#""x""#, "100000"] {
            let (s, w) = parse_settings(&format!(r#"{{ "terminal": {{ "doneAfterSeconds": {bad} }} }}"#));
            assert_eq!(s.terminal.done_after_seconds, 30, "{bad}");
            assert_eq!(w.len(), 1, "{bad}");
            assert!(w[0].starts_with("terminal.doneAfterSeconds"), "{bad}");
        }
    }

    #[test]
    fn default_file_text_lists_terminal_after_scrollback() {
        let text = default_file_text();
        let at = text.find("\"terminal\"").expect("terminal section");
        assert!(text.find("\"scrollback\"").unwrap() < at);
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
            parse_settings(r#"{ "keybindings": [ { "keys": "ctrl+shift+k", "action": "splitAuto" } ] }"#);
        assert_eq!(s.keybindings.len(), default_keybindings().len() + 1);
        assert!(find(&s, "ctrl+shift+k").is_some());
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

    fn bind(keys: &str, action: &str) -> KeybindingOp {
        let (keys, action) = (keys.into(), action.into());
        KeybindingOp::Bind { keys, action, direction: None, index: None, input: None }
    }

    fn merged(entries: &[Value]) -> Vec<Keybinding> {
        let (s, w) = parse_settings(&serde_json::json!({ "keybindings": entries }).to_string());
        assert!(w.iter().all(|w| !w.contains("invalid value, using defaults")), "{w:?}");
        s.keybindings
    }

    fn action_of(kbs: &[Keybinding], keys: &str) -> Option<String> {
        let chord = normalize_chord(keys);
        kbs.iter().find(|k| normalize_chord(&k.keys) == chord).map(|k| k.action.clone())
    }

    #[test]
    fn keybinding_op_deserializes_from_front_end_json() {
        let ops: Vec<KeybindingOp> = serde_json::from_str(
            r#"[
                { "op": "bind", "keys": "ctrl+alt+k", "action": "moveFocus", "direction": "left" },
                { "op": "bind", "keys": "ctrl+alt+j", "action": "switchToTab", "index": 3 },
                { "op": "unbind", "keys": "ctrl+w" },
                { "op": "reset", "keys": "f1" },
                { "op": "resetAll" }
            ]"#,
        )
        .unwrap();
        assert_eq!(
            ops,
            vec![
                KeybindingOp::Bind {
                    keys: "ctrl+alt+k".into(),
                    action: "moveFocus".into(),
                    direction: Some("left".into()),
                    index: None,
                    input: None,
                },
                KeybindingOp::Bind {
                    keys: "ctrl+alt+j".into(),
                    action: "switchToTab".into(),
                    direction: None,
                    index: Some(3),
                    input: None,
                },
                KeybindingOp::Unbind { keys: "ctrl+w".into() },
                KeybindingOp::Reset { keys: "f1".into() },
                KeybindingOp::ResetAll,
            ]
        );
    }

    #[test]
    fn bind_on_chord_with_no_default_adds_one_entry() {
        let out = apply_keybinding_ops(vec![], &[bind("ctrl+alt+k", "splitAuto")]);
        assert_eq!(out, vec![serde_json::json!({ "keys": "ctrl+alt+k", "action": "splitAuto" })]);
        assert_eq!(action_of(&merged(&out), "ctrl+alt+k").as_deref(), Some("splitAuto"));
    }

    #[test]
    fn bind_writes_arguments_in_key_order() {
        let out = apply_keybinding_ops(
            vec![],
            &[KeybindingOp::Bind {
                keys: "ctrl+alt+k".into(),
                action: "sendInput".into(),
                direction: None,
                index: None,
                input: Some("\u{1b}\r".into()),
            }],
        );
        assert_eq!(out[0].to_string(), r#"{"keys":"ctrl+alt+k","action":"sendInput","input":"\u001b\r"}"#);
    }

    #[test]
    fn bind_replaces_user_entry_with_different_spelling() {
        let entries = vec![serde_json::json!({ "keys": "Shift+Ctrl+L", "action": "splitAuto" })];
        let out = apply_keybinding_ops(entries, &[bind("ctrl+shift+l", "find")]);
        assert_eq!(out, vec![serde_json::json!({ "keys": "ctrl+shift+l", "action": "find" })]);
    }

    #[test]
    fn bind_equal_to_default_over_unbound_leaves_no_entry() {
        let entries = vec![serde_json::json!({ "keys": "ctrl+w", "action": "unbound" })];
        let out = apply_keybinding_ops(entries, &[bind("Ctrl+W", "closePane")]);
        assert!(out.is_empty());
        assert_eq!(merged(&out), default_keybindings());
    }

    #[test]
    fn bind_equal_to_default_compares_arguments() {
        let left = KeybindingOp::Bind {
            keys: "alt+left".into(),
            action: "moveFocus".into(),
            direction: Some("left".into()),
            index: None,
            input: None,
        };
        assert!(apply_keybinding_ops(vec![], &[left]).is_empty());
        let right = KeybindingOp::Bind {
            keys: "alt+left".into(),
            action: "moveFocus".into(),
            direction: Some("right".into()),
            index: None,
            input: None,
        };
        assert_eq!(apply_keybinding_ops(vec![], &[right]).len(), 1);
    }

    #[test]
    fn unbind_adds_unbound_only_for_a_default_chord() {
        let out = apply_keybinding_ops(vec![], &[KeybindingOp::Unbind { keys: "ctrl+w".into() }]);
        assert_eq!(out, vec![serde_json::json!({ "keys": "ctrl+w", "action": "unbound" })]);
        assert_eq!(action_of(&merged(&out), "ctrl+w"), None);

        let entries = vec![serde_json::json!({ "keys": "ctrl+alt+k", "action": "splitAuto" })];
        let out = apply_keybinding_ops(entries, &[KeybindingOp::Unbind { keys: "ctrl+alt+k".into() }]);
        assert!(out.is_empty());
    }

    #[test]
    fn reset_removes_user_entry_so_default_returns() {
        let entries = vec![serde_json::json!({ "keys": "CTRL+w", "action": "find" })];
        assert_eq!(action_of(&merged(&entries), "ctrl+w").as_deref(), Some("find"));
        let out = apply_keybinding_ops(entries, &[KeybindingOp::Reset { keys: "ctrl+w".into() }]);
        assert!(out.is_empty());
        assert_eq!(action_of(&merged(&out), "ctrl+w").as_deref(), Some("closePane"));
    }

    #[test]
    fn rejected_entries_and_unrelated_order_are_kept() {
        let entries = vec![
            serde_json::json!({ "keys": 5 }),
            serde_json::json!({ "keys": "ctrl+alt+a", "action": "find" }),
            serde_json::json!({ "action": "find" }),
            serde_json::json!({ "keys": "ctrl+shift+d", "action": "splitAuto" }),
            serde_json::json!({ "keys": "ctrl+alt+b", "action": "copy" }),
        ];
        let out = apply_keybinding_ops(entries.clone(), &[bind("ctrl+shift+d", "find")]);
        assert_eq!(
            out,
            vec![
                entries[0].clone(),
                entries[1].clone(),
                entries[2].clone(),
                entries[4].clone(),
                serde_json::json!({ "keys": "ctrl+shift+d", "action": "find" }),
            ]
        );
    }

    #[test]
    fn move_is_one_bind() {
        let out = apply_keybinding_ops(vec![], &[bind("ctrl+shift+d", "splitAuto")]);
        let kbs = merged(&out);
        assert_eq!(action_of(&kbs, "ctrl+shift+d").as_deref(), Some("splitAuto"));
        assert!(kbs.iter().all(|k| k.action != "toggleBackdrop"));
    }

    #[test]
    fn reset_all_empties() {
        let entries = vec![serde_json::json!({ "keys": 5 }), serde_json::json!({ "keys": "f1", "action": "unbound" })];
        let out = apply_keybinding_ops(entries, &[KeybindingOp::ResetAll]);
        assert!(out.is_empty());
        assert_eq!(merged(&out), default_keybindings());
    }

    #[test]
    fn ops_apply_in_order() {
        let out = apply_keybinding_ops(
            vec![],
            &[
                bind("ctrl+alt+k", "find"),
                KeybindingOp::Unbind { keys: "ctrl+w".into() },
                KeybindingOp::Reset { keys: "ctrl+alt+k".into() },
            ],
        );
        assert_eq!(out, vec![serde_json::json!({ "keys": "ctrl+w", "action": "unbound" })]);
    }

    #[test]
    fn raw_keybindings_reads_the_array() {
        assert_eq!(raw_keybindings("{}").unwrap(), Vec::<Value>::new());
        let text = r#"{
            // keys
            "keybindings": [
                { "keys": 5 }, // rejected but kept
                /* block */ { "keys": "ctrl+w", "action": "unbound" }
            ]
        }"#;
        assert_eq!(
            raw_keybindings(text).unwrap(),
            vec![serde_json::json!({ "keys": 5 }), serde_json::json!({ "keys": "ctrl+w", "action": "unbound" })]
        );
    }

    #[test]
    fn raw_keybindings_refuses_an_unusable_file() {
        let e = raw_keybindings(r#"{ "keybindings": { "keys": "ctrl+w" } }"#).unwrap_err();
        assert!(e.contains("fix it in settings.json"), "{e}");
        assert!(raw_keybindings("[]").unwrap_err().contains("fix it in settings.json"));
        assert!(raw_keybindings("{ nope").unwrap_err().contains("fix it in settings.json"));
    }

    fn parsed_keys(text: &str) -> Vec<Keybinding> {
        let (s, _) = parse_settings(text);
        s.keybindings
    }

    #[test]
    fn edit_keeps_the_default_files_comment_and_adds_the_chord() {
        let text = default_file_text();
        let out = edit_keybindings_text(&text, &[bind("ctrl+alt+k", "find")]).unwrap().0;
        assert!(out.contains("An entry with \"action\": \"unbound\""), "{out}");
        let kbs = parsed_keys(&out);
        assert_eq!(action_of(&kbs, "ctrl+alt+k").as_deref(), Some("find"));
        assert_eq!(action_of(&kbs, "ctrl+w").as_deref(), Some("closePane"));
    }

    #[test]
    fn edit_keeps_outside_comments_and_rejected_entries() {
        let text = "{\n  // before\n  \"keybindings\": [\n    { \"keys\": 5 },\n    { \"keys\": \"f1\", \"action\": \"unbound\" }\n  ],\n  // after\n  \"scrollback\": 100\n}\n";
        let out = edit_keybindings_text(text, &[bind("ctrl+alt+k", "find")]).unwrap().0;
        assert!(out.contains("// before") && out.contains("// after"), "{out}");
        assert!(out.contains("{ \"keys\": 5 }"), "{out}");
        assert!(out.contains("\"scrollback\": 100"), "{out}");
        let kbs = parsed_keys(&out);
        assert_eq!(action_of(&kbs, "ctrl+alt+k").as_deref(), Some("find"));
        assert_eq!(action_of(&kbs, "f1"), None);
    }

    #[test]
    fn edit_move_takes_a_chord_from_its_default_owner() {
        let defaults = default_keybindings();
        let before = action_of(&defaults, "ctrl+w").unwrap();
        assert_eq!(before, "closePane");
        let out = edit_keybindings_text(&default_file_text(), &[bind("ctrl+w", "find")]).unwrap().0;
        let kbs = parsed_keys(&out);
        assert_eq!(action_of(&kbs, "ctrl+w").as_deref(), Some("find"));
        assert!(kbs.iter().filter(|k| k.action == "closePane").all(|k| normalize_chord(&k.keys) != "ctrl+w"));
    }

    #[test]
    fn replace_all_restores_rejected_entries_and_keeps_the_rest_of_the_file() {
        let text = "{\n  // before\n  \"keybindings\": [\n    { \"keys\": 5 },\n    { \"keys\": \"ctrl+w\", \"action\": \"find\" },\n    { \"action\": \"nope\" }\n  ],\n  // after\n  \"scrollback\": 100\n}\n";
        let (reset, previous) = edit_keybindings_text(text, &[KeybindingOp::ResetAll]).unwrap();
        assert_eq!(previous, raw_keybindings(text).unwrap());
        assert!(raw_keybindings(&reset).unwrap().is_empty());
        let (restored, cleared) =
            edit_keybindings_text(&reset, &[KeybindingOp::ReplaceAll { entries: previous }]).unwrap();
        assert!(cleared.is_empty());
        assert_eq!(restored, text);

        let op: KeybindingOp = serde_json::from_str(r#"{ "op": "replaceAll", "entries": [{ "keys": 5 }] }"#).unwrap();
        assert_eq!(op, KeybindingOp::ReplaceAll { entries: vec![serde_json::json!({ "keys": 5 })] });
    }

    #[test]
    fn edit_refuses_an_invalid_file() {
        let e = edit_keybindings_text(r#"{ "keybindings": 7 }"#, &[bind("ctrl+alt+k", "find")]).unwrap_err();
        assert!(e.contains("fix it in settings.json"), "{e}");
        assert!(edit_keybindings_text("{ nope", &[]).is_err());
    }

    #[test]
    fn chord_aliases_match_keymap_ts() {
        assert_eq!(normalize_chord("win+left"), normalize_chord("meta+left"));
        assert_eq!(normalize_chord("Ctrl+Esc"), "ctrl+escape");
        assert_eq!(normalize_chord("shift+del"), normalize_chord("shift+delete"));
        assert_eq!(normalize_chord("ctrl+ins"), "ctrl+insert");
        assert_eq!(normalize_chord("ctrl++"), "ctrl++");

        let entries = vec![serde_json::json!({ "keys": "win+left", "action": "find" })];
        let out = apply_keybinding_ops(entries, &[bind("meta+left", "copy")]);
        assert_eq!(out, vec![serde_json::json!({ "keys": "meta+left", "action": "copy" })]);
    }

    fn event(kind: notify::EventKind, paths: &[&str]) -> notify::Result<notify::Event> {
        let mut ev = notify::Event::new(kind);
        for p in paths {
            ev = ev.add_path(PathBuf::from(p));
        }
        Ok(ev)
    }

    #[test]
    fn event_may_touch_matches_the_file_and_its_aliases() {
        use notify::event::{EventKind, Flag, ModifyKind, RenameMode};
        let file = Path::new("C:/cfg/settings.json");
        let any = EventKind::Any;
        assert!(event_may_touch(&event(any, &["C:/cfg/settings.json"]), file));
        assert!(event_may_touch(&event(any, &["C:/cfg/Settings.JSON"]), file));
        assert!(event_may_touch(&event(any, &["C:/cfg/SETTIN~1.JSO"]), file));
        let rename_to = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        assert!(event_may_touch(&event(rename_to, &["C:/cfg/settings.json"]), file));
        let rename_both = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        assert!(event_may_touch(&event(rename_both, &["C:/cfg/sedAb12", "C:/cfg/settings.json"]), file));
        // Overflow and backend errors carry no usable path.
        assert!(event_may_touch(&event(any, &[]), file));
        assert!(event_may_touch(&event(any, &["C:/cfg"]), file));
        let rescan = notify::Event::new(any).add_path("C:/cfg/x".into()).set_flag(Flag::Rescan);
        assert!(event_may_touch(&Ok(rescan), file));
        assert!(event_may_touch(&Err(notify::Error::generic("boom")), file));

        assert!(!event_may_touch(&event(any, &["C:/cfg/workspace.json"]), file));
        assert!(!event_may_touch(&event(any, &["C:/cfg/settings.json.tmp"]), file));
        assert!(!event_may_touch(&event(any, &["C:/cfg/WORKSP~1.JSO"]), file));
        assert!(!event_may_touch(&event(any, &["C:/cfg/sedAb12"]), file));
    }

    /// Drives the real watcher through outside edits that replace or rewrite the file: a temp
    /// file renamed over it (`sed -i`, editors) and an in-place truncate and write (`cat >`),
    /// including a pause mid-write that splits the events into two bursts.
    #[test]
    fn watcher_fires_for_rename_over_and_truncate_overwrite() {
        use std::io::Write;
        use std::sync::mpsc::RecvTimeoutError;
        let dir = std::env::temp_dir().join(format!("bashboard-settings-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, r#"{ "scrollback": 1 }"#).unwrap();

        let (tx, rx) = mpsc::channel::<u32>();
        let read_path = path.clone();
        let _watcher = watch_file(&path, move || {
            let _ = tx.send(reload(&read_path, &Settings::default()).0.scrollback);
        })
        .unwrap();
        // Waits for the reload that sees `want`, skipping any made on a half-written file.
        let expect = |want: u32| loop {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(got) if got == want => break,
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => panic!("no reload saw scrollback {want}"),
                Err(e) => panic!("{e}"),
            }
        };

        let tmp = dir.join("sedXy12ab");
        std::fs::write(&tmp, r#"{ "scrollback": 2 }"#).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        expect(2);

        let tmp = dir.join("settings.json.tmp");
        std::fs::write(&tmp, r#"{ "scrollback": 3 }"#).unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        expect(3);

        std::fs::write(&path, r#"{ "scrollback": 4 }"#).unwrap();
        expect(4);

        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(br#"{ "scrollback":"#).unwrap();
        f.flush().unwrap();
        thread::sleep(Duration::from_millis(400));
        f.write_all(b" 5 }").unwrap();
        drop(f);
        expect(5);

        thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        std::fs::write(dir.join("workspace.json"), "{}").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err(), "an unrelated file triggered a reload");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
