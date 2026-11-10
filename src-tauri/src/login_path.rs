//! The `PATH` from the user's login shell, adopted at startup off Windows. An app opened from
//! Finder or the Dock inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, not the `PATH` the
//! user's shell files build, so Homebrew, `~/.local/bin`, and version managers would be
//! invisible to everything the core runs (git, docker, gh, agent detection). Panes are not the
//! reason: they start login shells, which build their own.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// Long enough for a heavy `~/.zshrc` (oh-my-zsh, nvm); the window waits on it.
const TIMEOUT: Duration = Duration::from_secs(3);
const START: &str = "__BASHBOARD_PATH_START__";
const END: &str = "__BASHBOARD_PATH_END__";

/// Must run before any thread starts, since it sets the process environment. A launch from a
/// shell (`SHLVL` set, as under `pnpm tauri dev`) already has the user's `PATH` and is left as is.
pub fn adopt() {
    if cfg!(windows) || std::env::var_os("SHLVL").is_some() {
        return;
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into());
    match read_from(&shell) {
        // SAFETY: called first thing in `run`, before Tauri or anything else starts a thread.
        Some(path) => unsafe { std::env::set_var("PATH", path) },
        None => eprintln!("login_path: could not read the login shell's PATH; keeping the inherited one"),
    }
}

fn read_from(shell: &str) -> Option<String> {
    // Markers around the value, since shell startup files may print their own output.
    let script = format!("printf '%s%s%s' '{START}' \"$PATH\" '{END}'");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(TIMEOUT);
    // A shell still running at the deadline (a startup file waiting on input) is ended.
    let _ = child.kill();
    let _ = child.wait();
    extract(&out.ok()?)
}

/// The value between the markers, when it looks like a `PATH`.
fn extract(out: &str) -> Option<String> {
    let rest = &out[out.find(START)? + START.len()..];
    let path = rest[..rest.find(END)?].trim();
    path.contains('/').then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_ignores_startup_file_output() {
        let out = format!("Welcome!\n{START}/opt/homebrew/bin:/usr/bin{END}\nbye");
        assert_eq!(extract(&out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
    }

    #[test]
    fn extract_needs_both_markers_and_a_path() {
        assert_eq!(extract("/usr/bin:/bin"), None);
        assert_eq!(extract(&format!("{START}/usr/bin")), None);
        assert_eq!(extract(&format!("{START}{END}")), None);
        assert_eq!(extract(&format!("{START}  {END}")), None);
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_real_login_shell() {
        let path = read_from("/bin/sh").expect("sh reports a PATH");
        assert!(path.split(':').any(|d| d == "/usr/bin" || d == "/bin"), "{path}");
    }
}
