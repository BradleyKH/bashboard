//! What every program the app starts gets: no console window on Windows, and on Linux, none of
//! an AppImage runtime's environment.
//!
//! An AppImage's runtime points `PATH`, `LD_LIBRARY_PATH`, `PYTHONHOME`, `XDG_DATA_DIRS`, and
//! GTK's module variables into its mount so the app loads its bundled libraries. A shell, git,
//! or browser that inherited them would load those instead of the system's, and Python would not
//! start at all. The app's own environment keeps them, since WebKit's helper processes need
//! them, so each spawn removes them instead.

use std::process::{Command, Stdio};

/// Variables the AppImage runtime and its GTK hook set outright, never extending a user value.
/// `GTK_THEME` is among them because the hook overwrites it, so the user's value is already lost.
const RUNTIME_ONLY: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD", "PYTHONDONTWRITEBYTECODE", "GTK_THEME"];

/// Hides the console and cleans the environment for a program the app starts.
pub fn prepare(cmd: &mut Command) -> &mut Command {
    hide_console(cmd);
    for (key, value) in fixes() {
        match value {
            Some(v) => cmd.env(key, v),
            None => cmd.env_remove(key),
        };
    }
    cmd
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: a console program (Zed's CLI, vswhere) would otherwise flash a window.
    // GUI programs ignore it.
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

/// The changes a child's environment needs: a value to set, or `None` to remove. Empty outside
/// an AppImage. Read fresh each time, since `login_path` replaces `PATH` after startup.
pub fn fixes() -> Vec<(String, Option<String>)> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let vars: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    appimage_fixes(&vars)
}

/// `name` as a child sees it after `fixes`.
pub fn var(name: &str) -> Option<String> {
    match fixes().into_iter().find(|(k, _)| k == name) {
        Some((_, value)) => value,
        None => std::env::var(name).ok(),
    }
}

/// Drops `RUNTIME_ONLY` and every `:`-separated entry inside `APPDIR`, removing a variable left
/// empty. Pure, so it is tested on every OS.
fn appimage_fixes(vars: &[(String, String)]) -> Vec<(String, Option<String>)> {
    let Some(appdir) = vars
        .iter()
        .find(|(k, _)| k == "APPDIR")
        .map(|(_, v)| v.trim_end_matches('/'))
        .filter(|v| !v.is_empty())
    else {
        return Vec::new();
    };
    let inside = |entry: &str| entry.strip_prefix(appdir).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'));
    vars.iter()
        .filter_map(|(key, value)| {
            if RUNTIME_ONLY.contains(&key.as_str()) {
                return Some((key.clone(), None));
            }
            if !value.split(':').any(inside) {
                return None;
            }
            let kept: Vec<&str> = value.split(':').filter(|e| !e.is_empty() && !inside(e)).collect();
            Some((key.clone(), (!kept.is_empty()).then(|| kept.join(":"))))
        })
        .collect()
}

/// Opens a URL or a path with the desktop's default handler. Inside an AppImage the opener
/// plugin would start that handler, often a browser, with the bundled libraries, so there
/// `xdg-open` runs with `prepare`'s environment instead.
pub fn open_default(app: &tauri::AppHandle, target: &str, is_url: bool) -> Result<(), String> {
    if fixes().is_empty() {
        use tauri_plugin_opener::OpenerExt;
        let opener = app.opener();
        let opened = if is_url {
            opener.open_url(target, None::<&str>)
        } else {
            opener.open_path(target, None::<&str>)
        };
        return opened.map_err(|e| e.to_string());
    }
    let mut cmd = Command::new("xdg-open");
    cmd.arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = prepare(&mut cmd).spawn().map_err(|e| format!("could not run xdg-open: {e}"))?;
    // Reaped on its own thread so it does not linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn fix<'a>(fixes: &'a [(String, Option<String>)], key: &str) -> Option<Option<&'a str>> {
        fixes.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_deref())
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        assert!(appimage_fixes(&vars(&[("PATH", "/usr/bin"), ("GTK_THEME", "Adwaita:dark")])).is_empty());
        assert!(appimage_fixes(&vars(&[("APPDIR", "/"), ("PATH", "/usr/bin")])).is_empty());
    }

    #[test]
    fn appimage_entries_and_runtime_variables_are_removed() {
        let m = "/tmp/.mount_BashbX";
        let f = appimage_fixes(&vars(&[
            ("APPDIR", m),
            ("APPIMAGE", "/home/me/Bashboard.AppImage"),
            ("OWD", "/home/me"),
            ("GTK_THEME", "Adwaita:light"),
            ("PATH", &format!("{m}/usr/bin/:{m}//usr/sbin:/usr/local/bin:/usr/bin")),
            ("LD_LIBRARY_PATH", &format!("{m}/usr/lib/:{m}/usr/lib/x86_64-linux-gnu/:")),
            ("XDG_DATA_DIRS", &format!("{m}/usr/share/:/usr/local/share:/usr/share")),
            ("GTK_PATH", &format!("{m}//usr/lib/gtk-3.0")),
            ("PYTHONHOME", &format!("{m}/usr/")),
            ("HOME", "/home/me"),
            ("CDPATH", "/tmp/.mount_BashbXY:/srv"),
        ]));
        for gone in ["APPDIR", "APPIMAGE", "OWD", "GTK_THEME", "LD_LIBRARY_PATH", "GTK_PATH", "PYTHONHOME"] {
            assert_eq!(fix(&f, gone), Some(None), "{gone}");
        }
        assert_eq!(fix(&f, "PATH"), Some(Some("/usr/local/bin:/usr/bin")));
        assert_eq!(fix(&f, "XDG_DATA_DIRS"), Some(Some("/usr/local/share:/usr/share")));
        // A sibling folder that only shares the mount's name prefix is not inside it.
        assert_eq!(fix(&f, "CDPATH"), None);
        assert_eq!(fix(&f, "HOME"), None);
    }
}
