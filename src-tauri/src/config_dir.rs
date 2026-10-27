//! The folder that holds settings.json, workspace.json, favorites.json, and layouts.json.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Debug builds use a `dev` subfolder so a `pnpm tauri dev` run alongside the installed app
/// neither restores nor overwrites its saved workspace, nor hot-reloads its settings.
pub fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(if cfg!(debug_assertions) {
        dir.join("dev")
    } else {
        dir
    })
}

/// Seeds a debug build's settings from the installed app's file the first time, so a dev run
/// starts with the same look and shells. Returns whether a copy was made.
pub fn seed_dev_file(app: &AppHandle, name: &str) -> std::io::Result<bool> {
    if !cfg!(debug_assertions) {
        return Ok(false);
    }
    // Lets a debug run exercise the first-run path on a machine that has the installed app.
    if std::env::var_os("BASHBOARD_NO_DEV_SEED").is_some_and(|v| !v.is_empty()) {
        return Ok(false);
    }
    let Ok(release) = app.path().app_config_dir() else {
        return Ok(false);
    };
    seed(&release.join(name), &release.join("dev").join(name))
}

fn seed(from: &Path, to: &Path) -> std::io::Result<bool> {
    if to.exists() || !from.is_file() {
        return Ok(false);
    }
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::copy(from, to)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bashboard-config-dir-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn seed_copies_when_target_missing() {
        let dir = temp_dir("copy");
        let from = dir.join("settings.json");
        std::fs::write(&from, "{}").unwrap();
        let to = dir.join("dev").join("settings.json");
        assert!(seed(&from, &to).unwrap());
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "{}");
    }

    #[test]
    fn seed_keeps_an_existing_target() {
        let dir = temp_dir("keep");
        let from = dir.join("settings.json");
        std::fs::write(&from, "{\"a\":1}").unwrap();
        let to = dir.join("dev").join("settings.json");
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::write(&to, "{}").unwrap();
        assert!(!seed(&from, &to).unwrap());
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "{}");
    }

    #[test]
    fn seed_skips_a_missing_source() {
        let dir = temp_dir("missing");
        let to = dir.join("dev").join("settings.json");
        assert!(!seed(&dir.join("settings.json"), &to).unwrap());
        assert!(!to.exists());
    }
}
