//! Single instance (design section 3.18): a second launch hands its working directory to the
//! running app and exits, and the running app comes to the front, opening a tab in that folder
//! when the folder says where the user was.

// Debug builds skip the plugin, so only the tests reach this module there.
#![cfg_attr(debug_assertions, allow(dead_code))]

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

/// Called in the running app with the second launch's working directory.
pub fn on_second_launch(app: &AppHandle, cwd: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let windows_dir = std::env::var_os("SystemRoot").map(PathBuf::from);
    let folder = launch_folder(&cwd, exe_dir.as_deref(), windows_dir.as_deref());
    let _ = app.emit("instance://launched", folder);
}

/// The folder a new tab should open in, or `None` for a launch whose working directory is not
/// the user's: Start menu and taskbar shortcuts start in the install folder, and some launchers
/// start in the Windows folder.
fn launch_folder(cwd: &str, exe_dir: Option<&Path>, windows_dir: Option<&Path>) -> Option<String> {
    let path = Path::new(cwd);
    if cwd.is_empty() || !path.is_dir() {
        return None;
    }
    let same = |other: &Path| crate::workspace::same_root(cwd, &other.to_string_lossy());
    if exe_dir.is_some_and(same) {
        return None;
    }
    if let Some(win) = windows_dir {
        let lower = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
        let cwd_l = lower(path);
        let win_l = lower(win);
        if cwd_l == win_l || cwd_l.starts_with(&format!("{}\\", win_l.trim_end_matches('\\'))) {
            return None;
        }
    }
    Some(cwd.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-si-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        dir
    }

    #[test]
    fn a_real_folder_opens_a_tab() {
        let dir = temp_dir("real");
        let cwd = dir.to_string_lossy().into_owned();
        assert_eq!(launch_folder(&cwd, None, None), Some(cwd));
    }

    #[test]
    fn missing_or_empty_folders_only_focus() {
        assert_eq!(launch_folder("", None, None), None);
        assert_eq!(launch_folder("C:\\definitely\\not\\here", None, None), None);
    }

    #[test]
    fn the_install_folder_only_focuses() {
        let dir = temp_dir("exe");
        let cwd = dir.to_string_lossy().to_uppercase();
        assert_eq!(launch_folder(&cwd, Some(&dir), None), None);
        let sub = dir.join("sub").to_string_lossy().into_owned();
        assert_eq!(launch_folder(&sub, Some(&dir), None), Some(sub));
    }

    #[test]
    fn the_windows_folder_and_below_only_focus() {
        let dir = temp_dir("win");
        let cwd = dir.to_string_lossy().into_owned();
        let sub = dir.join("sub").to_string_lossy().into_owned();
        assert_eq!(launch_folder(&cwd, None, Some(&dir)), None);
        assert_eq!(launch_folder(&sub, None, Some(&dir)), None);
    }
}
