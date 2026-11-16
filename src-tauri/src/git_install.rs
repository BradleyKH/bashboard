//! Installs Git when it is missing (docs/design/app.md section 3.15): Git for Windows (which
//! provides Git Bash) through winget, or Apple's Command Line Tools through `xcode-select` on
//! macOS. On Linux nothing is run; the status carries the distribution's install command, read
//! from `os-release`, for the front end to show and copy. The pure parts (winget lookup,
//! argument list, output trimming, os-release parsing) take their inputs as parameters so tests
//! never touch the real machine.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::lock::LockExt;
use crate::settings::SettingsState;

#[cfg_attr(not(windows), allow(dead_code))]
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
const TAIL_LINES: usize = 8;

/// What can install Git here.
#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum GitInstaller {
    Winget,
    /// `xcode-select --install`, which opens macOS's own installer for the Command Line Tools.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    XcodeSelect,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallStatus {
    /// Git Bash on Windows, a working `git` elsewhere.
    pub git_found: bool,
    /// `None` when nothing here can install it, so the front end links to git-scm.com.
    pub installer: Option<GitInstaller>,
    /// The distribution's package-manager command, shown for the user to run themselves. Only
    /// Linux fills it, and only for a distribution it recognizes.
    pub install_command: Option<String>,
}

/// The `os-release` value for `key`, with one layer of single or double quotes removed.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn os_release_value<'a>(os_release: &'a str, key: &str) -> Option<&'a str> {
    os_release.lines().find_map(|line| {
        let (k, v) = line.trim().split_once('=')?;
        if k.trim() != key {
            return None;
        }
        let v = v.trim();
        let unquoted = v
            .strip_prefix('"')
            .and_then(|r| r.strip_suffix('"'))
            .or_else(|| v.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')));
        Some(unquoted.unwrap_or(v))
    })
}

/// The command that installs Git on the distribution `os_release` describes: its `ID` first,
/// then each family it declares in `ID_LIKE`, so a derivative with no entry of its own still
/// gets its parent's command.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn install_command(os_release: &str) -> Option<String> {
    let id = os_release_value(os_release, "ID").unwrap_or("");
    let like = os_release_value(os_release, "ID_LIKE").unwrap_or("");
    std::iter::once(id).chain(like.split_whitespace()).find_map(|id| {
        let cmd = match id.to_ascii_lowercase().as_str() {
            "debian" | "ubuntu" | "kali" | "linuxmint" | "pop" => "sudo apt install git",
            "fedora" | "rhel" | "centos" | "almalinux" | "rocky" => "sudo dnf install git",
            "arch" | "cachyos" | "manjaro" | "endeavouros" => "sudo pacman -S git",
            "gentoo" => "sudo emerge --ask dev-vcs/git",
            "opensuse" | "suse" | "opensuse-leap" | "opensuse-tumbleweed" | "sles" => {
                "sudo zypper install git"
            }
            _ => return None,
        };
        Some(cmd.to_string())
    })
}

/// `/etc/os-release`, else `/usr/lib/os-release`, which the spec makes the fallback location.
#[cfg(target_os = "linux")]
fn read_os_release() -> Option<String> {
    ["/etc/os-release", "/usr/lib/os-release"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
}

/// `winget.exe` on PATH, else the App Execution Alias under `%LOCALAPPDATA%\Microsoft\WindowsApps`
/// (which a GUI process may not have on its PATH).
#[cfg_attr(not(windows), allow(dead_code))]
fn find_winget(path_var: &OsStr, local_app_data: Option<&Path>) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|dir| dir.join("winget.exe"))
        .chain(local_app_data.map(|d| d.join("Microsoft").join("WindowsApps").join("winget.exe")))
        .find(|p| p.is_file())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn winget_path() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    find_winget(&path_var, local.as_deref())
}

/// `--scope user` makes winget run the Inno installer with /CURRENTUSER, so there is no admin
/// prompt and Git lands in `%LOCALAPPDATA%\Programs\Git`, a location profiles.rs detects.
#[cfg_attr(not(windows), allow(dead_code))]
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
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn tail_lines(output: &str, n: usize) -> String {
    let lines: Vec<&str> = output
        .lines()
        .map(|l| l.rsplit('\r').next().unwrap_or(l).trim())
        .filter(|l| !l.is_empty() && !l.chars().all(|c| matches!(c, '-' | '\\' | '|' | '/')))
        .collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn status_for(git_bash_found: bool, winget: Option<PathBuf>) -> GitInstallStatus {
    GitInstallStatus {
        git_found: git_bash_found,
        installer: winget.map(|_| GitInstaller::Winget),
        install_command: None,
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn git_install_status(settings: State<'_, SettingsState>) -> GitInstallStatus {
    let git_bash_found = crate::profiles::available_profiles(&settings.current().shell)
        .iter()
        .any(|p| p.id == crate::profiles::GIT_BASH);
    status_for(git_bash_found, winget_path())
}

/// `/usr/bin/git` is always there on macOS, but until the Command Line Tools are installed it
/// is a stub that opens their installer instead of running, so the check is `xcode-select -p`.
/// A Homebrew git works without them.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn git_install_status(_settings: State<'_, SettingsState>) -> GitInstallStatus {
    let tools = Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let brew_git = ["/opt/homebrew/bin/git", "/usr/local/bin/git"].iter().any(|p| Path::new(p).is_file());
    GitInstallStatus {
        git_found: tools || brew_git,
        installer: Some(GitInstaller::XcodeSelect),
        install_command: None,
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub fn git_install_status(_settings: State<'_, SettingsState>) -> GitInstallStatus {
    let file = crate::platform::exe_name("git");
    let found = std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(&file).is_file()));
    #[cfg(target_os = "linux")]
    let install_command = read_os_release().and_then(|text| install_command(&text));
    #[cfg(not(target_os = "linux"))]
    let install_command = None;
    GitInstallStatus { git_found: found, installer: None, install_command }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn drain<R: Read + Send + 'static>(mut r: R, buf: Arc<Mutex<Vec<u8>>>) {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 {
                break;
            }
            buf.lock_or_recover().extend_from_slice(&chunk[..n]);
        }
    });
}

#[cfg_attr(not(windows), allow(dead_code))]
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
    let text = String::from_utf8_lossy(&out.lock_or_recover()).into_owned();
    let code = status.code().map_or("unknown".to_string(), |c| format!("{c:#x}"));
    Err(format!("winget exited with code {code}\n{}", tail_lines(&text, TAIL_LINES)))
}

#[cfg(windows)]
#[tauri::command]
pub async fn git_install() -> Result<(), String> {
    let winget = winget_path().ok_or("winget was not found on this machine")?;
    tauri::async_runtime::spawn_blocking(move || run_install(&winget, INSTALL_TIMEOUT))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens macOS's Command Line Tools installer and returns once it is showing; the install
/// itself runs in that window, outside Bashboard.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn git_install() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = Command::new("/usr/bin/xcode-select")
            .arg("--install")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("could not start xcode-select: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&[out.stdout, out.stderr].concat()).into_owned();
        Err(format!("xcode-select did not open the installer\n{}", tail_lines(&text, TAIL_LINES)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub async fn git_install() -> Result<(), String> {
    Err("install Git with your distribution's package manager".into())
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
        assert_eq!(status_for(false, None).installer, None);
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
        assert_eq!(json, r#"{"gitFound":true,"installer":null,"installCommand":null}"#);
        let json = serde_json::to_string(&status_for(false, Some(PathBuf::from("winget.exe")))).unwrap();
        assert_eq!(json, r#"{"gitFound":false,"installer":"winget","installCommand":null}"#);
        let mac = GitInstallStatus {
            git_found: false,
            installer: Some(GitInstaller::XcodeSelect),
            install_command: None,
        };
        assert_eq!(
            serde_json::to_string(&mac).unwrap(),
            r#"{"gitFound":false,"installer":"xcodeSelect","installCommand":null}"#
        );
        let linux = GitInstallStatus {
            git_found: false,
            installer: None,
            install_command: Some("sudo apt install git".into()),
        };
        assert_eq!(
            serde_json::to_string(&linux).unwrap(),
            r#"{"gitFound":false,"installer":null,"installCommand":"sudo apt install git"}"#
        );
    }

    const APT: Option<&str> = Some("sudo apt install git");
    const DNF: Option<&str> = Some("sudo dnf install git");
    const PACMAN: Option<&str> = Some("sudo pacman -S git");

    #[test]
    fn debian_family_uses_apt() {
        let ubuntu = r#"PRETTY_NAME="Ubuntu 22.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
VERSION_CODENAME=jammy
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
UBUNTU_CODENAME=jammy
"#;
        assert_eq!(install_command(ubuntu).as_deref(), APT);
        let debian = r#"PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
"#;
        assert_eq!(install_command(debian).as_deref(), APT);
        let kali = r#"PRETTY_NAME="Kali GNU/Linux Rolling"
NAME="Kali GNU/Linux"
VERSION_ID="2024.1"
ID=kali
ID_LIKE=debian
HOME_URL="https://www.kali.org/"
"#;
        assert_eq!(install_command(kali).as_deref(), APT);
    }

    #[test]
    fn fedora_and_rhel_family_use_dnf() {
        let fedora = r#"NAME="Fedora Linux"
VERSION="40 (Container Image)"
ID=fedora
VERSION_ID=40
PLATFORM_ID="platform:f40"
PRETTY_NAME="Fedora Linux 40 (Container Image)"
"#;
        assert_eq!(install_command(fedora).as_deref(), DNF);
        let alma = r#"NAME="AlmaLinux"
VERSION="10.0 (Purple Lion)"
ID="almalinux"
ID_LIKE="rhel centos fedora"
VERSION_ID="10.0"
"#;
        assert_eq!(install_command(alma).as_deref(), DNF);
        let rhel = r#"NAME="Red Hat Enterprise Linux"
VERSION="10.0 (Coughlan)"
ID="rhel"
ID_LIKE="fedora"
VERSION_ID="10.0"
"#;
        assert_eq!(install_command(rhel).as_deref(), DNF);
    }

    #[test]
    fn arch_family_uses_pacman() {
        let arch = "NAME=\"Arch Linux\"\nPRETTY_NAME=\"Arch Linux\"\nID=arch\nBUILD_ID=rolling\n";
        assert_eq!(install_command(arch).as_deref(), PACMAN);
        let cachy = "NAME=\"CachyOS Linux\"\nPRETTY_NAME=\"CachyOS\"\nID=cachyos\nID_LIKE=arch\nBUILD_ID=rolling\n";
        assert_eq!(install_command(cachy).as_deref(), PACMAN);
    }

    #[test]
    fn gentoo_and_suse_have_their_own_commands() {
        let gentoo = "NAME=Gentoo\nID=gentoo\nPRETTY_NAME=\"Gentoo Linux\"\n";
        assert_eq!(install_command(gentoo).as_deref(), Some("sudo emerge --ask dev-vcs/git"));
        let tumbleweed = r#"NAME="openSUSE Tumbleweed"
ID="opensuse-tumbleweed"
ID_LIKE="opensuse suse"
VERSION_ID="20240101"
"#;
        assert_eq!(install_command(tumbleweed).as_deref(), Some("sudo zypper install git"));
    }

    #[test]
    fn id_beats_id_like_and_unknown_is_none() {
        // A derivative's own ID is matched before the family it declares.
        assert_eq!(install_command("ID=arch\nID_LIKE=debian\n").as_deref(), PACMAN);
        // An unrecognized ID falls through to ID_LIKE, in order.
        assert_eq!(install_command("ID=mydistro\nID_LIKE=\"foo ubuntu fedora\"\n").as_deref(), APT);
        assert_eq!(install_command("ID=nixos\nNAME=NixOS\n"), None);
        assert_eq!(install_command("ID=alpine\nID_LIKE=\"\"\n"), None);
        assert_eq!(install_command(""), None);
    }

    #[test]
    fn quoting_comments_and_blank_lines_are_tolerated() {
        assert_eq!(install_command("# a comment\n\nID='fedora'\n").as_deref(), DNF);
        assert_eq!(install_command("ID=\"fedora\"\n").as_deref(), DNF);
        assert_eq!(install_command("ID=fedora\r\n").as_deref(), DNF);
        // A commented-out ID is not an ID, and keys that merely end in ID are not ID.
        assert_eq!(install_command("#ID=fedora\nBUILD_ID=fedora\nVARIANT_ID=fedora\n"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_reads_an_os_release_file() {
        // A minimal container can lack both files, so the read is checked against their presence.
        let exists = ["/etc/os-release", "/usr/lib/os-release"].iter().any(|p| Path::new(p).is_file());
        assert_eq!(read_os_release().is_some(), exists);
    }
}
