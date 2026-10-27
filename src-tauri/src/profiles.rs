//! Shell profiles a pane can run: Git Bash (configured by `shell.path` and `shell.args`),
//! PowerShell 7 and Windows PowerShell when installed, and Command Prompt. Only profiles
//! whose executable exists are offered, and cmd always is, so resolving a profile can
//! never land on a shell that fails to start.

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use serde::Serialize;
use tauri::State;

use crate::settings::{self, SettingsState, Shell};

pub const GIT_BASH: &str = "gitBash";
pub const PWSH: &str = "pwsh";
pub const POWERSHELL: &str = "powershell";
pub const CMD: &str = "cmd";
/// Also the fallback order when neither the requested nor the default profile is available.
pub const PROFILE_IDS: &[&str] = &[GIT_BASH, PWSH, POWERSHELL, CMD];

const CMD_FALLBACK: &str = r"C:\Windows\System32\cmd.exe";
const SYSTEM_ROOT_FALLBACK: &str = r"C:\Windows";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
}

fn profile(id: &str, name: &str, path: String, args: Vec<String>) -> ShellProfile {
    ShellProfile {
        id: id.into(),
        name: name.into(),
        path,
        args,
    }
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The expanded `configured` path if it exists. Only when it is the built-in default does
/// the search widen to a per-user install and a Git found on `path_var`; a path the user
/// set explicitly is taken at its word.
fn find_git_bash(
    configured: &str,
    is_default_path: bool,
    path_var: &OsStr,
    local_app_data: Option<&Path>,
) -> Option<PathBuf> {
    let configured = PathBuf::from(settings::expand_env(configured));
    if configured.is_file() {
        return Some(configured);
    }
    if !is_default_path {
        return None;
    }
    let per_user =
        local_app_data.map(|d| d.join("Programs").join("Git").join("bin").join("bash.exe"));
    // Git for Windows puts `git.exe` in `<root>\cmd` (the usual PATH entry) and `<root>\bin`,
    // and `bash.exe` in `<root>\bin`.
    let from_path = std::env::split_paths(path_var)
        .filter(|dir| dir.join("git.exe").is_file())
        .filter(|dir| {
            dir.file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|n| n.eq_ignore_ascii_case("cmd") || n.eq_ignore_ascii_case("bin"))
        })
        .filter_map(|dir| dir.parent().map(|root| root.join("bin").join("bash.exe")));
    per_user.into_iter().chain(from_path).find(|p| p.is_file())
}

/// First `pwsh.exe` on `path_var`, else under `<program_files>\PowerShell\7`.
fn find_pwsh(path_var: &OsStr, program_files: Option<&Path>) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|dir| dir.join("pwsh.exe"))
        .chain(program_files.map(|pf| pf.join("PowerShell").join("7").join("pwsh.exe")))
        .find(|p| p.is_file())
}

/// Searched once per run: an install made while the app is open shows up after a restart.
fn detected_pwsh() -> Option<&'static PathBuf> {
    static PWSH_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PWSH_PATH
        .get_or_init(|| {
            let path_var = std::env::var_os("PATH").unwrap_or_default();
            let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
            find_pwsh(&path_var, program_files.as_deref())
        })
        .as_ref()
}

fn find_windows_powershell(system_root: Option<&Path>) -> Option<PathBuf> {
    let root = system_root.unwrap_or(Path::new(SYSTEM_ROOT_FALLBACK));
    Some(
        root.join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
    )
    .filter(|p| p.is_file())
}

fn detected_windows_powershell() -> Option<&'static PathBuf> {
    static POWERSHELL_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    POWERSHELL_PATH
        .get_or_init(|| {
            let system_root = std::env::var_os("SystemRoot")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from);
            find_windows_powershell(system_root.as_deref())
        })
        .as_ref()
}

/// `comspec` when it names an existing file, else the stock location.
fn cmd_path(comspec: Option<String>) -> String {
    comspec
        .filter(|s| !s.is_empty() && Path::new(s).is_file())
        .unwrap_or_else(|| CMD_FALLBACK.into())
}

/// Built in `PROFILE_IDS` order, which `pick` relies on as the fallback chain.
fn build_profiles(
    shell: &Shell,
    git_bash: Option<&Path>,
    pwsh: Option<&Path>,
    powershell: Option<&Path>,
    comspec: Option<String>,
) -> Vec<ShellProfile> {
    let mut list = Vec::new();
    if let Some(p) = git_bash {
        list.push(profile(
            GIT_BASH,
            "Git Bash",
            path_string(p),
            shell.args.clone(),
        ));
    }
    if let Some(p) = pwsh {
        list.push(profile(
            PWSH,
            "PowerShell 7",
            path_string(p),
            vec!["-NoLogo".into()],
        ));
    }
    if let Some(p) = powershell {
        list.push(profile(
            POWERSHELL,
            "Windows PowerShell",
            path_string(p),
            vec!["-NoLogo".into()],
        ));
    }
    list.push(profile(
        CMD,
        "Command Prompt",
        cmd_path(comspec),
        Vec::new(),
    ));
    list
}

/// Git Bash is checked on every call because `shell.path` can change with a settings reload.
pub fn available_profiles(shell: &Shell) -> Vec<ShellProfile> {
    let is_default_path = shell.path == settings::DEFAULT_GIT_BASH_PATH;
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let git_bash = find_git_bash(
        &shell.path,
        is_default_path,
        &path_var,
        local_app_data.as_deref(),
    );
    build_profiles(
        shell,
        git_bash.as_deref(),
        detected_pwsh().map(PathBuf::as_path),
        detected_windows_powershell().map(PathBuf::as_path),
        std::env::var("ComSpec").ok(),
    )
}

/// The requested profile if available, else the configured default if available, else the
/// first available. cmd is always listed, so the list is never empty.
fn pick(requested: Option<&str>, default: &str, mut list: Vec<ShellProfile>) -> ShellProfile {
    let index = [requested, Some(default)]
        .into_iter()
        .flatten()
        .find_map(|id| list.iter().position(|p| p.id == id))
        .unwrap_or(0);
    list.swap_remove(index)
}

pub fn resolve(requested: Option<&str>, shell: &Shell) -> ShellProfile {
    pick(requested, &shell.default_profile, available_profiles(shell))
}

/// The profile a spawn asked for (the requested one, else the default) when a different one
/// had to start because it is not installed.
pub fn fallback_from(requested: Option<&str>, default: &str, started: &str) -> Option<String> {
    let wanted = requested.unwrap_or(default);
    (wanted != started).then(|| wanted.to_string())
}

#[tauri::command]
pub fn shell_profiles(settings: State<'_, SettingsState>) -> Vec<ShellProfile> {
    available_profiles(&settings.current().shell)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bashboard-profiles-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    fn shell() -> Shell {
        crate::settings::Settings::default().shell
    }

    #[test]
    fn fallback_from_names_the_missing_profile() {
        assert_eq!(
            fallback_from(None, GIT_BASH, PWSH).as_deref(),
            Some(GIT_BASH)
        );
        assert_eq!(
            fallback_from(Some(POWERSHELL), GIT_BASH, CMD).as_deref(),
            Some(POWERSHELL)
        );
        assert_eq!(fallback_from(Some(CMD), GIT_BASH, CMD), None);
        assert_eq!(fallback_from(None, PWSH, PWSH), None);
    }

    fn ids(list: &[ShellProfile]) -> Vec<&str> {
        list.iter().map(|p| p.id.as_str()).collect()
    }

    fn s(p: &Path) -> String {
        path_string(p)
    }

    #[test]
    fn git_bash_uses_configured_path_when_present() {
        let dir = temp_dir("gb-configured");
        let bash = dir.join("custom").join("bash.exe");
        touch(&bash);
        let local = dir.join("local");
        touch(
            &local
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
        assert_eq!(
            find_git_bash(&s(&bash), false, &OsString::new(), Some(&local)),
            Some(bash.clone())
        );
        assert_eq!(
            find_git_bash(&s(&bash), true, &OsString::new(), Some(&local)),
            Some(bash)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_default_git_bash_falls_back_to_local_app_data() {
        let dir = temp_dir("gb-local");
        let local = dir.join("local");
        let per_user = local
            .join("Programs")
            .join("Git")
            .join("bin")
            .join("bash.exe");
        touch(&per_user);
        let missing = s(&dir.join("missing").join("bash.exe"));
        assert_eq!(
            find_git_bash(&missing, true, &OsString::new(), Some(&local)),
            Some(per_user)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_default_git_bash_falls_back_to_git_on_path() {
        let dir = temp_dir("gb-path");
        let root = dir.join("Git");
        let bash = root.join("bin").join("bash.exe");
        touch(&root.join("cmd").join("git.exe"));
        touch(&bash);
        // A git.exe outside a cmd or bin folder is not a Git for Windows layout.
        let odd = dir.join("odd");
        touch(&odd.join("tools").join("git.exe"));
        touch(&odd.join("bin").join("bash.exe"));
        let path_var =
            std::env::join_paths([dir.join("empty"), odd.join("tools"), root.join("cmd")]).unwrap();
        let missing = s(&dir.join("missing").join("bash.exe"));
        assert_eq!(
            find_git_bash(&missing, true, &path_var, Some(&dir.join("nolocal"))),
            Some(bash)
        );
        assert_eq!(find_git_bash(&missing, true, &OsString::new(), None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_custom_git_bash_is_none_without_probing() {
        let dir = temp_dir("gb-custom");
        let local = dir.join("local");
        touch(
            &local
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
        let root = dir.join("Git");
        touch(&root.join("cmd").join("git.exe"));
        touch(&root.join("bin").join("bash.exe"));
        let path_var = std::env::join_paths([root.join("cmd")]).unwrap();
        let missing = s(&dir.join("missing").join("bash.exe"));
        assert_eq!(
            find_git_bash(&missing, false, &path_var, Some(&local)),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pwsh_found_on_path_before_program_files() {
        let dir = temp_dir("path");
        let (empty, on_path, pf) = (dir.join("empty"), dir.join("bin"), dir.join("pf"));
        std::fs::create_dir_all(&empty).unwrap();
        touch(&on_path.join("pwsh.exe"));
        touch(&pf.join("PowerShell").join("7").join("pwsh.exe"));
        let path_var = std::env::join_paths([&empty, &on_path]).unwrap();
        assert_eq!(
            find_pwsh(&path_var, Some(&pf)),
            Some(on_path.join("pwsh.exe"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pwsh_falls_back_to_program_files() {
        let dir = temp_dir("pf");
        let pf = dir.join("pf");
        touch(&pf.join("PowerShell").join("7").join("pwsh.exe"));
        let path_var = std::env::join_paths([dir.join("nope")]).unwrap();
        assert_eq!(
            find_pwsh(&path_var, Some(&pf)),
            Some(pf.join("PowerShell").join("7").join("pwsh.exe"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pwsh_missing_everywhere_is_none() {
        let dir = temp_dir("none");
        let path_var = std::env::join_paths([&dir]).unwrap();
        assert_eq!(find_pwsh(&path_var, Some(&dir)), None);
        assert_eq!(find_pwsh(&OsString::new(), None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_powershell_only_when_present_under_system_root() {
        let dir = temp_dir("winps");
        assert_eq!(find_windows_powershell(Some(&dir)), None);
        let exe = dir
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        touch(&exe);
        assert_eq!(find_windows_powershell(Some(&dir)), Some(exe));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn comspec_used_only_when_it_exists() {
        let dir = temp_dir("comspec");
        let cmd = dir.join("cmd.exe");
        touch(&cmd);
        assert_eq!(cmd_path(Some(s(&cmd))), s(&cmd));
        assert_eq!(cmd_path(Some(s(&dir.join("missing.exe")))), CMD_FALLBACK);
        assert_eq!(cmd_path(Some(String::new())), CMD_FALLBACK);
        assert_eq!(cmd_path(None), CMD_FALLBACK);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn profiles_in_order_and_each_only_when_found() {
        let dir = temp_dir("order");
        let cmd = dir.join("cmd.exe");
        touch(&cmd);
        let with = build_profiles(
            &shell(),
            Some(Path::new(r"C:\Git\bin\bash.exe")),
            Some(Path::new(r"C:\pwsh\pwsh.exe")),
            Some(Path::new(r"C:\ps\powershell.exe")),
            Some(s(&cmd)),
        );
        assert_eq!(ids(&with), [GIT_BASH, PWSH, POWERSHELL, CMD]);
        assert_eq!(ids(&with), PROFILE_IDS);
        assert_eq!(with[0].path, r"C:\Git\bin\bash.exe");
        assert_eq!(with[0].args, shell().args);
        let no_logo = ["-NoLogo".to_string()];
        assert_eq!(
            (with[1].path.as_str(), with[1].args.as_slice()),
            (r"C:\pwsh\pwsh.exe", no_logo.as_slice())
        );
        assert_eq!(
            (with[2].path.as_str(), with[2].args.as_slice()),
            (r"C:\ps\powershell.exe", no_logo.as_slice())
        );
        assert_eq!(with[3].path, s(&cmd));
        assert!(with[3].args.is_empty());
        let names: Vec<_> = with.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Git Bash",
                "PowerShell 7",
                "Windows PowerShell",
                "Command Prompt"
            ]
        );

        let without = build_profiles(&shell(), None, None, None, None);
        assert_eq!(ids(&without), [CMD]);
        assert_eq!(without[0].path, CMD_FALLBACK);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_prefers_requested_then_default_then_first_available() {
        let bash = Some(Path::new("bash.exe"));
        let pwsh = Some(Path::new("pwsh.exe"));
        let ps = Some(Path::new("powershell.exe"));
        let all = || build_profiles(&shell(), bash, pwsh, ps, None);
        let no_pwsh = || build_profiles(&shell(), bash, None, ps, None);
        assert_eq!(pick(Some(CMD), PWSH, all()).id, CMD);
        assert_eq!(pick(None, PWSH, all()).id, PWSH);
        assert_eq!(pick(None, POWERSHELL, all()).id, POWERSHELL);
        assert_eq!(pick(Some("zsh"), CMD, all()).id, CMD);
        assert_eq!(pick(Some(PWSH), CMD, no_pwsh()).id, CMD);
        assert_eq!(pick(Some(PWSH), PWSH, no_pwsh()).id, GIT_BASH);
        assert_eq!(pick(None, "bogus", all()).id, GIT_BASH);
    }

    #[test]
    fn missing_git_bash_falls_through_the_chain() {
        let pwsh = Some(Path::new("pwsh.exe"));
        let ps = Some(Path::new("powershell.exe"));
        let pick_default = |list| pick(None, GIT_BASH, list).id;
        assert_eq!(
            pick_default(build_profiles(&shell(), None, pwsh, ps, None)),
            PWSH
        );
        assert_eq!(
            pick_default(build_profiles(&shell(), None, None, ps, None)),
            POWERSHELL
        );
        assert_eq!(
            pick_default(build_profiles(&shell(), None, None, None, None)),
            CMD
        );
        assert_eq!(
            pick(
                Some(GIT_BASH),
                GIT_BASH,
                build_profiles(&shell(), None, None, None, None)
            )
            .id,
            CMD
        );
    }

    #[test]
    fn profile_serializes_camel_case() {
        let json =
            serde_json::to_value(profile(CMD, "Command Prompt", "cmd.exe".into(), Vec::new()))
                .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "id": "cmd", "name": "Command Prompt", "path": "cmd.exe", "args": [] })
        );
    }
}
