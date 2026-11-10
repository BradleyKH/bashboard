//! The OS-dependent basics other modules share: the user's home folder, the `PATH` separator,
//! executable file names, and the OS name the front end reads once at startup to hide features
//! that have no implementation on it.

use std::path::PathBuf;

use serde::Serialize;

/// The separator between `PATH` entries.
pub const PATH_LIST_SEP: char = if cfg!(windows) { ';' } else { ':' };

/// `name` as an executable file name: `bash` becomes `bash.exe` on Windows.
pub fn exe_name(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

/// The user's home folder. On Windows `USERPROFILE` comes first: Git Bash sets `HOME` for its
/// own children, and an app started from a pane would otherwise inherit that.
pub fn user_home() -> Option<PathBuf> {
    let vars: &[&str] = if cfg!(windows) { &["USERPROFILE", "HOME"] } else { &["HOME"] };
    vars.iter()
        .filter_map(|v| std::env::var_os(v))
        .find(|h| !h.is_empty())
        .map(PathBuf::from)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// `std::env::consts::OS`: "windows", "macos", "linux".
    pub os: &'static str,
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo { os: std::env::consts::OS }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_name_matches_the_build_os() {
        let expected = if cfg!(windows) { "bash.exe" } else { "bash" };
        assert_eq!(exe_name("bash"), expected);
    }
}
