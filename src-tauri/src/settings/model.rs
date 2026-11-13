//! The settings types, their defaults, and the ids each enumerated field accepts.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::keybindings::default_keybindings;

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
    pub matrix: MatrixBackdrop,
    pub wave: WaveBackdrop,
    pub image: ImageBackdrop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixBackdrop {
    /// One of `MATRIX_COLOR_MODES`; see `parse_matrix_color`.
    pub color: String,
    pub zoom: f64,
    /// Rain steps per second.
    pub speed: u32,
    /// Scales how often an idle column starts a new drop.
    pub density: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveBackdrop {
    /// One of `WAVE_COLOR_MODES`.
    pub color: String,
    /// Share of the window the figure's widest point fills.
    pub size: f64,
    /// Scales the spin, tilt, and detune sweep.
    pub speed: f64,
    /// CSS pixels on the line's near side.
    pub line_width: f64,
    pub echoes: u32,
}

/// The Image and Slideshow styles' settings; `file` is Image's, the rest Slideshow's, and `fit`
/// both.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBackdrop {
    /// May contain `%VARS%`; empty until the user picks one.
    pub file: String,
    pub folder: String,
    /// One of `IMAGE_FITS`.
    pub fit: String,
    pub interval_seconds: u32,
    /// 0 swaps pictures with no fade.
    pub crossfade_seconds: f64,
    pub shuffle: bool,
    pub include_subfolders: bool,
}

/// Ids `backdrop.style` accepts (docs/design/data.md section 8).
pub const BACKDROP_STYLES: [&str; 7] = ["none", "lights", "galaxy", "matrix", "wave", "image", "slideshow"];

/// Ids `backdrop.image.fit` accepts, the Windows wallpaper modes less Span.
pub const IMAGE_FITS: [&str; 5] = ["fill", "fit", "stretch", "center", "tile"];

/// The front end derives the rain's color from the mode and the accent
/// (src/backdrop/matrix/rainColor.ts).
pub const MATRIX_COLOR_MODES: [&str; 2] = ["green", "accent"];

/// The front end resolves the line's color from the mode and the accent
/// (src/backdrop/wave/waveColor.ts).
pub const WAVE_COLOR_MODES: [&str; 3] = ["accent", "white", "spectrum"];

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
    /// Ports the dashboard lists before counting the rest; `PORT_ROWS_RANGE`.
    pub port_rows: u32,
}

pub const DEFAULT_ACCENT: &str = "#4fb3c8";

/// The front end derives the color from the mode and the accent (src/contentText.ts).
pub const CONTENT_TEXT_MODES: [&str; 2] = ["accent", "white"];
pub const DEFAULT_CONTENT_TEXT_MODE: &str = "accent";

/// Ids `codeColors.scheme` accepts: `matchAccent` follows the accent preset, `none` turns code
/// coloring off, the rest are fixed schemes (docs/design/files.md section 4.22). The front end
/// owns the palettes (src/code/).
pub const CODE_SCHEMES: [&str; 10] = [
    "matchAccent", "nord", "ayu", "gruvbox", "monokai", "tokyoNight", "oneDark", "catppuccinMocha",
    "dracula", "none",
];
pub const DEFAULT_CODE_SCHEME: &str = "matchAccent";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeColors {
    /// One of `CODE_SCHEMES`.
    pub scheme: String,
}

/// `uiScale` bounds: 1 is the compact default, and at 1.5 the dashboard's buttons match
/// the Launch section's (docs/design/README.md section 5).
pub const UI_SCALE_MIN: f64 = 1.0;
pub const BORDER_LIGHTS_SPEED_RANGE: std::ops::RangeInclusive<f64> = 10.0..=300.0;
pub const BORDER_LIGHTS_DENSITY_RANGE: std::ops::RangeInclusive<f64> = 0.25..=4.0;
pub const UI_SCALE_MAX: f64 = 2.0;

/// Ids `dashboard.side` accepts (docs/design/dashboard.md section 4.6).
pub const DASHBOARD_SIDES: [&str; 2] = ["left", "right"];

/// Ids `dashboard.clockStyle` accepts (docs/design/dashboard.md section 4.6).
pub const CLOCK_STYLES: [&str; 3] = ["both", "time", "binary"];

/// Bounds of `dashboard.portRows` (docs/design/dashboard.md section 4.6).
pub const PORT_ROWS_RANGE: std::ops::RangeInclusive<u32> = 1..=50;

/// Which dashboard elements show; fields follow the panel's default element order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSections {
    pub launch: bool,
    pub favorites: bool,
    pub layouts: bool,
    pub panes: bool,
    pub containers: bool,
    pub ports: bool,
    pub ship: bool,
    pub branch: bool,
    pub local_models: bool,
    pub external: bool,
    pub system: bool,
    pub wave: bool,
    pub clock: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Restore {
    pub enabled: bool,
    pub resume_sessions: bool,
    pub scrollback: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModels {
    /// Empty means the default `http://localhost:11434`.
    pub ollama_url: String,
    /// Empty means the default `http://localhost:1234`.
    pub lm_studio_url: String,
    /// Context length below which a loaded model is flagged; 0 turns the warning off.
    pub min_context: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSettings {
    /// Minutes between background fetches of repos with an open Git pane; 0 turns it off.
    pub auto_fetch_minutes: u32,
    /// Lines changed against the comparison ref (tests, lockfiles, and generated files excluded)
    /// above which the branch row and session cards show a size warning; 0 turns it off.
    pub branch_size_threshold: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSettings {
    /// Shows the cloud-context chip on each terminal pane.
    pub badge: bool,
    /// A JavaScript regex source the front end tests against a context name to mark it as
    /// production; stored as typed.
    pub production_pattern: String,
}

/// Forge kinds `ship.hosts` accepts.
pub const FORGE_KINDS: [&str; 4] = ["github", "gitlab", "bitbucket", "azureDevOps"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ship {
    /// Lowercased host name to one of `FORGE_KINDS`; see `parse_ship_hosts`.
    pub hosts: HashMap<String, String>,
    /// Minutes between Overview refreshes; 0 turns the heartbeat off.
    pub overview_refresh_minutes: u32,
    /// Repos pinned to the Ship Overview, in file order.
    pub pinned_repos: Vec<PinnedRepo>,
    /// Lets `bb ci rerun` and `bb ci cancel` act on pipelines; off because pipelines often deploy.
    pub cli_writes: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBrowser {
    /// Saved pages for the Local Browser pane, in file order.
    pub bookmarks: Vec<Bookmark>,
    /// Page a new Local Browser pane opens on; empty opens its start page.
    pub home_url: String,
    /// Absolute folders whose HTML files may reach any host (browser.md section 3.21).
    pub trusted_folders: Vec<String>,
    /// Absolute folder (or single file, for a page opened directly from the home folder or a drive
    /// root) to the hosts its pages may reach beyond `cdn_hosts`.
    pub allowed_hosts: HashMap<String, Vec<String>>,
    /// Hosts every local file page may load from.
    pub cdn_hosts: Vec<String>,
    /// Reload a local file page when its file changes on disk.
    pub reload_on_change: bool,
}

/// The public CDNs a generated page usually loads scripts, styles, and fonts from.
pub const DEFAULT_CDN_HOSTS: [&str; 5] =
    ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Bookmark {
    pub name: String,
    pub url: String,
}

/// `repo` (`<host>/<path segments>`) is the pin's identity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedRepo {
    pub repo: String,
    /// A local clone of the repo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// Branches shown in the health row beyond the automatic ones.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branches: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    /// Shell commands running at least this many seconds mark the terminal done or failed; 0 turns it off.
    pub done_after_seconds: u32,
    /// Shows a Windows notification when a terminal starts waiting while the window is unfocused.
    pub notify_when_waiting: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    /// One of `EDITOR_IDS`.
    pub preferred: String,
    /// When non-empty, replaces the editor's built-in arguments; see docs/design/files.md
    /// section 3.12.
    pub command: String,
}

/// Ids `editor.preferred` accepts (docs/design/files.md section 3.12).
pub const EDITOR_IDS: [&str; 20] = [
    "zed", "vscode", "cursor", "visualStudio", "notepadpp", "sublime", "rider", "intellij",
    "webstorm", "pycharm", "rustrover", "goland", "clion", "phpstorm", "windsurf",
    "vscodeInsiders", "vscodium", "vim", "nvim", "default",
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
    /// One of `CONTENT_TEXT_MODES`; see `parse_content_text`.
    pub content_text_color: String,
    pub code_colors: CodeColors,
    /// Multiplier on the app's chrome (controls, bars, titles, dialog text), `UI_SCALE_MIN..=UI_SCALE_MAX`.
    pub ui_scale: f64,
    /// The working-agent glow and the pane border lights (docs/design/sessions.md section 4.23); both off by default.
    pub agent_glow: bool,
    pub border_lights: bool,
    /// Px per second, `BORDER_LIGHTS_SPEED_RANGE`.
    pub border_lights_speed: f64,
    /// Comets per 1000 px of a pane's loop, `BORDER_LIGHTS_DENSITY_RANGE`.
    pub border_lights_density: f64,
    pub scrim: Scrim,
    pub backdrop: Backdrop,
    pub scrollback: u32,
    pub terminal: Terminal,
    pub dashboard: Dashboard,
    pub restore: Restore,
    pub editor: Editor,
    pub git: GitSettings,
    pub cloud: CloudSettings,
    pub local_models: LocalModels,
    pub ship: Ship,
    pub local_browser: LocalBrowser,
    pub keybindings: Vec<Keybinding>,
}

impl Settings {
    /// Host names lowercased, so a lookup by a remote's host matches however the file cased it.
    pub(crate) fn forge_hosts(&self) -> HashMap<String, String> {
        self.ship.hosts.iter().map(|(host, kind)| (host.to_lowercase(), kind.clone())).collect()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    pub settings: Settings,
    pub warnings: Vec<String>,
    /// True when this launch created settings.json (docs/design/app.md section 4.17).
    pub first_run: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            shell: Shell {
                path: DEFAULT_GIT_BASH_PATH.into(),
                args: vec!["--login".into(), "-i".into()],
                starting_directory: if cfg!(windows) { "%USERPROFILE%" } else { "%HOME%" }.into(),
                default_profile: crate::profiles::DEFAULT_PROFILE.into(),
            },
            font: Font {
                family: "JetBrainsMono Nerd Font Mono, Cascadia Mono".into(),
                size: 14.0,
            },
            accent_color: DEFAULT_ACCENT.into(),
            content_text_color: DEFAULT_CONTENT_TEXT_MODE.into(),
            code_colors: CodeColors { scheme: DEFAULT_CODE_SCHEME.into() },
            ui_scale: 1.0,
            agent_glow: false,
            border_lights: false,
            border_lights_speed: 60.0,
            border_lights_density: 1.0,
            scrim: Scrim { opacity: 0.5, blur_px: 1.0 },
            backdrop: Backdrop {
                style: "lights".into(),
                animate: false,
                max_fps: 20,
                capacity: 1000,
                mutation_rate: 0.2,
                zoom: 2.0,
                matrix: MatrixBackdrop { color: "green".into(), zoom: 1.0, speed: 10, density: 3.0 },
                wave: WaveBackdrop { color: "accent".into(), size: 0.85, speed: 0.5, line_width: 3.0, echoes: 4 },
                image: ImageBackdrop {
                    file: String::new(),
                    folder: String::new(),
                    fit: "fill".into(),
                    interval_seconds: 600,
                    crossfade_seconds: 5.0,
                    shuffle: true,
                    include_subfolders: false,
                },
            },
            scrollback: 10000,
            terminal: Terminal { done_after_seconds: 30, notify_when_waiting: true },
            dashboard: Dashboard {
                visible_on_start: true,
                peek_on_waiting: true,
                side: "right".into(),
                sections: DashboardSections {
                    launch: true,
                    favorites: false,
                    layouts: false,
                    panes: true,
                    containers: true,
                    ports: true,
                    ship: true,
                    branch: false,
                    local_models: true,
                    external: true,
                    system: false,
                    wave: false,
                    clock: false,
                },
                clock_style: "both".into(),
                port_rows: 10,
            },
            restore: Restore { enabled: true, resume_sessions: true, scrollback: true },
            editor: Editor { preferred: "default".into(), command: String::new() },
            git: GitSettings { auto_fetch_minutes: 5, branch_size_threshold: 400 },
            cloud: CloudSettings { badge: true, production_pattern: "prod|prd|live".into() },
            local_models: LocalModels { ollama_url: String::new(), lm_studio_url: String::new(), min_context: 64000 },
            ship: Ship {
                hosts: HashMap::new(),
                overview_refresh_minutes: 5,
                pinned_repos: Vec::new(),
                cli_writes: false,
            },
            local_browser: LocalBrowser {
                bookmarks: Vec::new(),
                home_url: String::new(),
                trusted_folders: Vec::new(),
                allowed_hosts: HashMap::new(),
                cdn_hosts: DEFAULT_CDN_HOSTS.iter().map(|h| h.to_string()).collect(),
                reload_on_change: true,
            },
            keybindings: default_keybindings(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_serializes_first_run_in_camel_case() {
        let payload = SettingsPayload { settings: Settings::default(), warnings: Vec::new(), first_run: true };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["firstRun"], true);
        assert!(json.get("first_run").is_none());
    }
}
