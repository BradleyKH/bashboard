//! The shells `/etc/shells` lists, for the shell profiles (docs/design/terminal.md section 3.1).
//! Every Linux distribution and macOS keep this file, and package managers add a shell to it on
//! install (pacman's and dpkg's `add-shell`, Microsoft's `pwsh` packages), so it finds shells no
//! fixed table names. It also lists programs that are valid login shells but not ones to open a
//! pane in (`git-shell`, `nologin`, Debian's `tmux` and `screen`), which `offered` drops.
//!
//! Pure, so it is tested on every OS; Windows never reads the file.
#![cfg_attr(windows, allow(dead_code))]

/// The absolute paths `text` lists: one per line, `#` starting a comment.
pub fn listed(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| l.starts_with('/'))
        .map(String::from)
        .collect()
}

/// Entries that are restricted shells, account locks, multiplexers, or `sh` itself, which
/// `/bin/sh` covers only as the login shell's last resort.
const NOT_OFFERED: &[&str] = &[
    "sh",
    "rbash",
    "rksh",
    "rzsh",
    "git-shell",
    "nologin",
    "false",
    "true",
    "sync",
    "systemd-home-fallback-shell",
    "tmux",
    "screen",
    "byobu",
    "rssh",
    "scponly",
];

/// Whether a shell with this file name belongs in the profile list.
pub fn offered(name: &str) -> bool {
    !NOT_OFFERED.contains(&name)
}

/// Shells known to take `-l` for a login shell. A shell not listed starts with no arguments,
/// since a flag it does not know may stop it from starting.
const TAKES_LOGIN_FLAG: &[&str] = &[
    "bash", "zsh", "fish", "nu", "pwsh", "xonsh", "dash", "ksh", "mksh", "oksh", "loksh", "yash",
    "tcsh", "csh", "osh", "ysh", "sh",
];

/// The arguments for a shell found in `/etc/shells`.
pub fn args(name: &str) -> Vec<String> {
    if TAKES_LOGIN_FLAG.contains(&name) {
        vec!["-l".into()]
    } else {
        vec![]
    }
}

/// Login shells that fail on `-l`. The login shell keeps `-l` otherwise, as it always has.
const REFUSES_LOGIN_FLAG: &[&str] = &["elvish"];

/// The arguments for the login shell.
pub fn login_args(name: &str) -> Vec<String> {
    if REFUSES_LOGIN_FLAG.contains(&name) {
        vec![]
    } else {
        vec!["-l".into()]
    }
}

/// The profile name for a shell with this file name.
pub fn display_name(name: &str) -> String {
    match name {
        "pwsh" => "PowerShell 7".into(),
        "nu" => "Nushell".into(),
        _ => name.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_absolute_paths_and_skips_comments() {
        let text = "# Pathnames of valid login shells.\n\n/bin/sh\n/usr/bin/fish # fish\n  /usr/bin/nu  \nnot/a/path\n";
        assert_eq!(listed(text), ["/bin/sh", "/usr/bin/fish", "/usr/bin/nu"]);
    }

    #[test]
    fn drops_what_is_not_a_shell_to_work_in() {
        for name in ["sh", "rbash", "git-shell", "nologin", "systemd-home-fallback-shell", "tmux", "screen"] {
            assert!(!offered(name), "{name}");
        }
        for name in ["bash", "zsh", "fish", "nu", "pwsh", "elvish", "xonsh", "tcsh", "dash", "ksh"] {
            assert!(offered(name), "{name}");
        }
    }

    #[test]
    fn login_flag_only_where_known() {
        assert_eq!(args("nu"), ["-l"]);
        assert_eq!(args("tcsh"), ["-l"]);
        assert!(args("elvish").is_empty());
        assert!(args("someshell").is_empty());
        assert_eq!(login_args("someshell"), ["-l"]);
        assert!(login_args("elvish").is_empty());
    }
}
