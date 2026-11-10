//! The settings file on disk: the commented default file, reads that degrade to defaults, and
//! serialized read-modify-write edits.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::AppHandle;

use super::model::Settings;
use super::parse::try_parse_settings;

pub(super) const FILE_NAME: &str = "settings.json";

/// Pretty JSONC with an empty `keybindings` array so later changes to the built-in
/// defaults reach existing files.
pub(super) fn default_file_text() -> String {
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
        "  // accent (a pale tint of accentColor) or white.
  \"contentTextColor\":",
    )
    .replace(
        "  \"codeColors\": {",
        "  // scheme is matchAccent (follows the accent color) or one of nord, ayu, gruvbox, monokai,
  // tokyoNight, oneDark, catppuccinMocha, dracula. Colors code in text previews.
  \"codeColors\": {",
    )
    .replace(
        "  \"uiScale\":",
        "  // Size of buttons, bars, titles, and dialog text (not pane content), from 1 (compact) to 2.
  \"uiScale\":",
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
  // nonzero exit, when they finish unseen. 0 turns it off. notifyWhenWaiting shows a Windows
  // notification when a terminal starts waiting while the window is unfocused.
  \"terminal\": {",
    )
    .replace(
        "  \"dashboard\": {",
        "  // side is left or right. sections shows or hides each dashboard element; sections.containers
  // also decides whether the kind menu offers a Containers pane (docs/design/dashboard.md
  // section 4.6).
  \"dashboard\": {",
    )
    .replace(
        "  \"git\": {",
        "  // Minutes between background fetches of repos with an open Git pane; 0 turns it off (3.9).
  \"git\": {",
    )
    .replace(
        "  \"localBrowser\": {",
        "  // bookmarks are { \"name\", \"url\" } pages for the Local Browser pane; only http URLs on
  // localhost or 127.0.0.1, and file:/// URLs to .html or .htm files, are kept. homeUrl is the
  // page a new pane opens on, empty for its start page. trustedFolders lists folders whose HTML
  // files may reach any host; allowedHosts maps a folder (or a file opened directly from the home
  // folder or a drive root) to extra hosts; cdnHosts lists the hosts every HTML file may load
  // from; reloadOnChange reloads a file page when its file is saved.
  \"localBrowser\": {",
    )
    .replace(
        "  \"keybindings\": []",
        "  // Entries add to or override the default keybindings listed in\n  // docs/design/keys.md section 4.5. An entry with \"action\": \"unbound\" removes the default for its keys.\n  \"keybindings\": []",
    )
}

pub(super) fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    crate::config_dir::config_dir(app).map(|d| d.join(FILE_NAME))
}

/// Returns true when it created the file.
pub(super) fn ensure_default_file(path: &Path) -> std::io::Result<bool> {
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

pub(super) fn load(path: &Path) -> (Settings, Vec<String>) {
    read(path).unwrap_or_else(|e| (Settings::default(), vec![format!("{e}, using defaults")]))
}

/// A mid-session save that leaves the file unusable keeps the running settings, so a typo
/// does not reset every pane to the defaults.
pub(super) fn reload(path: &Path, previous: &Settings) -> (Settings, Vec<String>) {
    read(path).unwrap_or_else(|e| (previous.clone(), vec![format!("{e}, keeping the previous settings")]))
}

/// Serializes every read-modify-write of the settings file so rapid calls (slider drags,
/// repeated hotkeys, key edits) cannot both read the same text and lose one of the edits.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Reads the settings file (creating it first if missing), applies `edit` to its text, and
/// writes the result back, all under `WRITE_LOCK`.
pub(super) fn edit_settings_file(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::model::{GitSettings, Restore};
    use crate::settings::parse::{parse_root, parse_settings};

    #[test]
    fn restore_defaults_to_enabled_and_is_in_default_file() {
        let d = Settings::default();
        assert_eq!(d.restore, Restore { enabled: true, resume_sessions: true, scrollback: true });
        let text = default_file_text();
        assert!(text.contains("\"restore\"") && text.contains("\"resumeSessions\""));
    }

    #[test]
    fn default_file_has_no_top_level_containers_key() {
        let v = parse_root(&default_file_text()).expect("default file parses");
        assert!(v.get("containers").is_none());
    }

    #[test]
    fn default_file_lists_dashboard_side_and_sections() {
        let text = default_file_text();
        assert!(text.contains("\"sections\"") && text.contains("\"side\""));
    }

    #[test]
    fn ship_hosts_default_to_empty_and_are_in_default_file() {
        assert!(Settings::default().ship.hosts.is_empty());
        assert!(Settings::default().forge_hosts().is_empty());
        assert!(default_file_text().contains("\"ship\""));
    }

    #[test]
    fn local_browser_defaults_and_is_in_default_file() {
        let b = Settings::default().local_browser;
        assert!(b.bookmarks.is_empty() && b.home_url.is_empty());
        let text = default_file_text();
        assert!(text.contains("\"localBrowser\"") && text.contains("\"bookmarks\": []"));
        let (s, w) = parse_settings(&text);
        assert_eq!(s.local_browser, b);
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn ship_overview_settings_default_and_are_in_default_file() {
        let f = Settings::default().ship;
        assert_eq!(f.overview_refresh_minutes, 5);
        assert!(f.pinned_repos.is_empty());
        let text = default_file_text();
        assert!(text.contains("\"overviewRefreshMinutes\": 5") && text.contains("\"pinnedRepos\": []"));
    }

    #[test]
    fn git_auto_fetch_minutes_defaults_to_5_and_is_in_default_file() {
        assert_eq!(Settings::default().git, GitSettings { auto_fetch_minutes: 5 });
        assert!(default_file_text().contains("\"git\""));
    }

    #[test]
    fn editor_is_in_default_file() {
        assert!(default_file_text().contains("\"editor\""));
    }

    #[test]
    fn default_file_text_lists_terminal_after_scrollback() {
        let text = default_file_text();
        let at = text.find("\"terminal\"").expect("terminal section");
        assert!(text.find("\"scrollback\"").unwrap() < at);
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
}
