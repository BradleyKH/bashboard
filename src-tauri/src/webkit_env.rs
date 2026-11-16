//! WebKitGTK environment the app sets for itself on Linux before the first webview exists
//! (docs/design/app.md section 3.31).
//!
//! WebKitGTK reads `WEBKIT_DISABLE_DMABUF_RENDERER` when it starts its web process, and its
//! DMA-BUF renderer draws a blank window on NVIDIA's proprietary driver and some others. The
//! choice is made from `linux.disableDmabufRenderer`, read straight from the settings file at the
//! top of `run`: Tauri loads settings in `setup`, after other threads exist, and setting a
//! variable then would race their reads of the environment.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::settings::AutoSwitch;

pub const DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Set when the app, not the user, put `DMABUF_VAR` in its environment, so `child_process`
/// keeps it from the shells and programs the app starts.
static APP_SET_DMABUF: AtomicBool = AtomicBool::new(false);

pub fn app_set_dmabuf() -> bool {
    APP_SET_DMABUF.load(Ordering::Relaxed)
}

/// Whether to turn the renderer off: as the setting says, or under `auto` on NVIDIA's
/// proprietary driver, which `/proc/driver/nvidia/version` marks.
fn disable_dmabuf(mode: AutoSwitch, nvidia: bool) -> bool {
    match mode {
        AutoSwitch::On => true,
        AutoSwitch::Off => false,
        AutoSwitch::Auto => nvidia,
    }
}

/// Where Tauri's `app_config_dir` puts the settings file on Linux: `$XDG_CONFIG_HOME` (when
/// absolute) or `~/.config`, then the identifier, then `dev` for a debug build (config_dir.rs).
fn settings_file(xdg_config_home: Option<&str>, home: Option<&Path>, debug: bool) -> Option<PathBuf> {
    let base = match xdg_config_home.filter(|d| Path::new(d).is_absolute()) {
        Some(d) => PathBuf::from(d),
        None => home?.join(".config"),
    };
    let dir = base.join(IDENTIFIER);
    Some(if debug { dir.join("dev") } else { dir }.join("settings.json"))
}

/// `identifier` in tauri.conf.json; a test keeps them equal.
const IDENTIFIER: &str = "dev.bashboard";

/// Sets `DMABUF_VAR` when the setting or the driver calls for it, unless the user set it already.
/// Must run before any thread starts.
#[cfg(target_os = "linux")]
pub fn apply() {
    if std::env::var_os(DMABUF_VAR).is_some() {
        return;
    }
    let home = crate::platform::user_home();
    let mode = settings_file(std::env::var("XDG_CONFIG_HOME").ok().as_deref(), home.as_deref(), cfg!(debug_assertions))
        .map(|f| crate::settings::read_before_start(&f).linux.disable_dmabuf_renderer)
        .unwrap_or(AutoSwitch::Auto);
    if disable_dmabuf(mode, Path::new("/proc/driver/nvidia/version").exists()) {
        // SAFETY: called at the top of `run`, before Tauri or anything else starts a thread.
        unsafe { std::env::set_var(DMABUF_VAR, "1") };
        APP_SET_DMABUF.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_disables_only_on_nvidia() {
        assert!(disable_dmabuf(AutoSwitch::Auto, true));
        assert!(!disable_dmabuf(AutoSwitch::Auto, false));
        assert!(disable_dmabuf(AutoSwitch::On, false));
        assert!(!disable_dmabuf(AutoSwitch::Off, true));
    }

    // Unix paths: `/x/cfg` is not absolute on Windows.
    #[cfg(unix)]
    #[test]
    fn settings_file_follows_tauris_config_dir() {
        let home = Path::new("/home/me");
        assert_eq!(
            settings_file(None, Some(home), false),
            Some(PathBuf::from("/home/me/.config/dev.bashboard/settings.json"))
        );
        assert_eq!(
            settings_file(Some("/x/cfg"), Some(home), true),
            Some(PathBuf::from("/x/cfg/dev.bashboard/dev/settings.json"))
        );
        assert_eq!(
            settings_file(Some("relative"), Some(home), false),
            Some(PathBuf::from("/home/me/.config/dev.bashboard/settings.json"))
        );
        assert_eq!(settings_file(None, None, false), None);
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
    }
}
