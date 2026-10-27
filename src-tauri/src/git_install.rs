//! Installs Git for Windows (which provides Git Bash) through winget when it is missing
//! (docs/design.md section 3.15). The pure parts (winget lookup, argument list, output
//! trimming) take their inputs as parameters so tests never touch the real machine.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::profiles;
use crate::settings::SettingsState;

const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const TAIL_LINES: usize = 8;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallStatus {
    pub git_bash_found: bool,
    pub winget_found: bool,
}

/// `winget.exe` on PATH, else the App Execution Alias under `%LOCALAPPDATA%\Microsoft\WindowsApps`
/// (which a GUI process may not have on its PATH).
fn find_winget(path_var: &OsStr, local_app_data: Option<&Path>) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|dir| dir.join("winget.exe"))
        .chain(local_app_data.map(|d| d.join("Microsoft").join("WindowsApps").join("winget.exe")))
        .find(|p| p.is_file())
}

fn winget_path() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    find_winget(&path_var, local.as_deref())
}

/// `--scope user` makes winget run the Inno installer with /CURRENTUSER, so there is no admin
/// prompt and Git lands in `%LOCALAPPDATA%\Programs\Git`, a location profiles.rs detects.
fn install_args() -> Vec<&'static str> {
    vec![
        "install",
        "--id",
        "Git.Git",
        "-e",
        "--source",
        "winget",
        "--scope",
        "user",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
    ]
}

/// The last `n` non-blank lines, with the carriage-return progress spinner winget prints
/// collapsed to its final frame.
fn tail_lines(output: &str, n: usize) -> String {
    let lines: Vec<&str> = output
        .lines()
        .map(|l| l.rsplit('\r').next().unwrap_or(l).trim())
        .filter(|l| !l.is_empty() && !l.chars().all(|c| matches!(c, '-' | '\\' | '|' | '/')))
        .collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn status_for(git_bash_found: bool, winget: Option<PathBuf>) -> GitInstallStatus {
    GitInstallStatus { git_bash_found, winget_found: winget.is_some() }
}

#[tauri::command]
pub fn git_install_status(settings: State<'_, SettingsState>) -> GitInstallStatus {
    let git_bash_found = profiles::available_profiles(&settings.current().shell)
        .iter()
        .any(|p| p.id == profiles::GIT_BASH);
    status_for(git_bash_found, winget_path())
}

fn drain<R: Read + Send + 'static>(mut r: R, buf: Arc<Mutex<Vec<u8>>>) {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 {
                break;
            }
            buf.lock().unwrap().extend_from_slice(&chunk[..n]);
        }
    });
}

fn run_install(winget: &Path, timeout: Duration) -> Result<(), String> {
    let mut cmd = Command::new(winget);
    cmd.args(install_args())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: winget is a console program and would flash a window.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start winget: {e}"))?;
    let out = Arc::new(Mutex::new(Vec::new()));
    if let Some(s) = child.stdout.take() {
        drain(s, out.clone());
    }
    if let Some(s) = child.stderr.take() {
        drain(s, out.clone());
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "winget did not finish within {} minutes",
                    timeout.as_secs() / 60
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => return Err(format!("could not wait for winget: {e}")),
        }
    };
    if status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
    let code = status.code().map_or("unknown".to_string(), |c| format!("{c:#x}"));
    Err(format!("winget exited with code {code}\n{}", tail_lines(&text, TAIL_LINES)))
}

#[tauri::command]
pub async fn git_install() -> Result<(), String> {
    let winget = winget_path().ok_or("winget was not found on this machine")?;
    tauri::async_runtime::spawn_blocking(move || run_install(&winget, INSTALL_TIMEOUT))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-git-install-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn winget_found_on_path() {
        let dir = temp_dir("path");
        std::fs::write(dir.join("winget.exe"), "").unwrap();
        let path_var = std::env::join_paths([temp_dir("empty"), dir.clone()]).unwrap();
        assert_eq!(find_winget(&path_var, None), Some(dir.join("winget.exe")));
    }

    #[test]
    fn winget_found_via_windows_apps_alias() {
        let local = temp_dir("local");
        let apps = local.join("Microsoft").join("WindowsApps");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(apps.join("winget.exe"), "").unwrap();
        assert_eq!(
            find_winget(OsStr::new(""), Some(&local)),
            Some(apps.join("winget.exe"))
        );
    }

    #[test]
    fn winget_missing() {
        let local = temp_dir("none");
        assert_eq!(find_winget(OsStr::new(""), Some(&local)), None);
        assert_eq!(find_winget(OsStr::new(""), None), None);
        assert!(!status_for(false, None).winget_found);
    }

    #[test]
    fn args_install_git_per_user_non_interactively() {
        let args = install_args();
        assert_eq!(&args[..3], ["install", "--id", "Git.Git"]);
        let pos = args.iter().position(|a| *a == "--scope").unwrap();
        assert_eq!(args[pos + 1], "user");
        for flag in ["-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"] {
            assert!(args.contains(&flag), "{flag}");
        }
    }

    #[test]
    fn tail_keeps_last_lines_and_drops_spinner_noise() {
        let out = "one\r\n  - \r  \\ \r  | \r\ntwo\r\n\r\nthree\nfour\n";
        assert_eq!(tail_lines(out, 2), "three\nfour");
        assert_eq!(tail_lines(out, 10), "one\ntwo\nthree\nfour");
        assert_eq!(tail_lines("", 3), "");
    }

    #[test]
    fn status_serializes_camel_case() {
        let json = serde_json::to_string(&status_for(true, None)).unwrap();
        assert_eq!(json, r#"{"gitBashFound":true,"wingetFound":false}"#);
    }
}
