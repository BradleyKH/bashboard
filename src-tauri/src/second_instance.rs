//! Single instance (design section 3.18): a second launch hands its arguments and working
//! directory to the running app and exits, and the running app comes to the front, opening a tab
//! in the folder named on the command line (Explorer's "Open in Bashboard") or, failing that, in
//! the working directory when it says where the user was. A first launch's folder argument is
//! held for the front end to take at startup.

// Debug builds skip the plugin, so only the tests reach the second-launch path there.
#![cfg_attr(debug_assertions, allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

/// The folder named on this process's own command line.
#[derive(Default)]
pub struct StartupFolder(Mutex<Option<String>>);

impl StartupFolder {
    pub fn from_args() -> Self {
        let args: Vec<String> = std::env::args().skip(1).collect();
        Self(Mutex::new(folder_arg(&args)))
    }
}

/// Returns the startup folder once; clearing it keeps a page reload from opening the tab again.
#[tauri::command]
pub fn startup_folder_take(state: State<'_, StartupFolder>) -> Option<String> {
    state.0.lock().ok().and_then(|mut f| f.take())
}

/// Called in the running app with the second launch's arguments (exe path first) and working
/// directory.
pub fn on_second_launch(app: &AppHandle, args: Vec<String>, cwd: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    let windows_dir = std::env::var_os("SystemRoot").map(PathBuf::from);
    let folder = folder_arg(args.get(1..).unwrap_or_default())
        .or_else(|| launch_folder(&cwd, exe_dir.as_deref(), windows_dir.as_deref()));
    let _ = app.emit("instance://launched", folder);
}

/// The first argument that names an existing folder. Explorer's `"%V"` for a drive root is
/// `"C:\"`, whose backslash escapes the closing quote, so it arrives as `C:"`; that is repaired
/// to `C:\` (a bare `C:` would mean the current directory on drive C).
fn folder_arg(args: &[String]) -> Option<String> {
    args.iter().find_map(|arg| {
        let mut path = arg.trim_end_matches('"').to_string();
        if path.len() == 2 && path.ends_with(':') {
            path.push(std::path::MAIN_SEPARATOR);
        }
        (!path.is_empty() && Path::new(&path).is_dir()).then_some(path)
    })
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
    fn the_first_folder_argument_wins() {
        let dir = temp_dir("arg");
        let folder = dir.join("sub").to_string_lossy().into_owned();
        let file = dir.join("file.txt");
        std::fs::write(&file, "").unwrap();
        let args = vec!["--flag".to_string(), file.to_string_lossy().into_owned(), folder.clone()];
        assert_eq!(folder_arg(&args), Some(folder));
        assert_eq!(folder_arg(&[]), None);
        assert_eq!(folder_arg(&["C:/definitely/not/here".to_string()]), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_drive_root_with_an_escaped_quote_is_repaired() {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(folder_arg(&[format!("{drive}\"")]), Some(format!("{drive}{sep}")));
        assert_eq!(folder_arg(&[format!("{drive}{sep}")]), Some(format!("{drive}{sep}")));
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
