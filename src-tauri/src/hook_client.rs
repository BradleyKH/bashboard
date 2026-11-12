//! `bb hook <agent> [event]`, the agent side of the hook receiver (docs/design/sessions.md
//! section 3.3). Agents run it on every hook event: it forwards the event's JSON from standard
//! input to `POST /hook` and prints the agent's expected reply. Shared by the app (which reads
//! the version marker of an installed copy) and `bb` (which includes this file by path), so it
//! depends on nothing in the crate.

use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Bump on every change to the hook's behavior: the app only replaces an installed copy whose
/// version is lower than its own.
pub const HOOK_VERSION: u32 = 3;
pub const VERSION_PREFIX: &str = "bashboard-hook-version:";

/// The installer finds the version by scanning an installed binary's bytes for this marker, so
/// it must survive linking; `#[used]` and `--version` reading it both keep it.
#[used]
static VERSION_MARKER: [u8; 25] = *b"bashboard-hook-version:3;";

/// Matches `MAX_BODY` in hooks.rs; the receiver rejects anything larger.
const MAX_BODY: usize = 64 * 1024;
/// An agent waits on every hook call, so a stalled stdin must not hold it for long.
const READ_DEADLINE: Duration = Duration::from_secs(2);
const USAGE: &str = "usage: bb hook <claude|codex|copilot> [event] | bb hook --version";

/// The posting half, supplied by `bb`: the hook URL, extra headers, and the body. It ignores
/// every error.
pub type Post<'a> = &'a dyn Fn(&str, &[(&str, &str)], &[u8]);

/// The installed hook's file name.
pub fn binary_name() -> String {
    format!("bashboard-hook{}", std::env::consts::EXE_SUFFIX)
}

/// The hook version embedded in a binary's bytes, if any.
pub fn version_in(bytes: &[u8]) -> Option<u32> {
    let prefix = VERSION_PREFIX.as_bytes();
    let start = bytes.windows(prefix.len()).position(|w| w == prefix)? + prefix.len();
    let rest = &bytes[start..];
    let end = rest.iter().position(|&b| b == b';')?;
    let digits = &rest[..end];
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

fn marker() -> &'static str {
    std::str::from_utf8(&VERSION_MARKER).unwrap_or_default()
}

/// Runs the hook and returns the exit code, which is always 0: a failing hook would surface as
/// an error in the agent, and Bashboard being away is not one.
pub fn run(args: &[String], post: Post) -> u8 {
    let (agent, event) = match args {
        [flag] if flag == "--version" => {
            println!("{}", marker());
            return 0;
        }
        [agent] => (agent.as_str(), None),
        [agent, event] => (agent.as_str(), Some(event.as_str())),
        _ => {
            eprintln!("{USAGE}");
            return 0;
        }
    };
    // Before any network work, so a failed POST can never cost the agent its reply.
    if let Some(text) = reply(agent, event) {
        let mut out = io::stdout();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
    let url = std::env::var("BASHBOARD_HOOK_URL").unwrap_or_default();
    if url.is_empty() {
        return 0;
    }
    let body = read_bounded(io::stdin(), READ_DEADLINE, MAX_BODY);
    if let Some(path) = std::env::var_os("BASHBOARD_HOOK_LOG").filter(|p| !p.is_empty()) {
        log(&path, agent, &body);
    }
    // The receiver answers 400 to an empty body, so skipping it spares the agent a connect wait.
    if body.trim_ascii().is_empty() {
        return 0;
    }
    let token = std::env::var("BASHBOARD_HOOK_TOKEN").unwrap_or_default();
    let pane = std::env::var("BASHBOARD_PANE_ID").unwrap_or_default();
    let mut headers = vec![
        ("X-Bashboard-Token", token.as_str()),
        ("X-Bashboard-Pane", pane.as_str()),
        ("X-Bashboard-Agent", agent),
    ];
    if let Some(event) = event {
        headers.push(("X-Bashboard-Event", event));
    }
    post(&url, &headers, &body);
    0
}

/// What the agent reads from the hook's standard output. Codex's PermissionRequest and
/// Copilot's permissionRequest read stdout as an allow or deny decision, and empty output
/// leaves the normal prompt, so None must print nothing at all.
fn reply(agent: &str, _event: Option<&str>) -> Option<&'static str> {
    match agent {
        "claude" | "codex" | "copilot" => None,
        _ => None,
    }
}

/// Reads up to `max` bytes, stopping at EOF, at the deadline, or once the bytes so far are one
/// complete JSON object or array. The last is what returns promptly when an agent writes its
/// payload but leaves stdin open. The reader thread is never joined: it may stay blocked on a
/// read until the process exits.
fn read_bounded<R: Read + Send + 'static>(mut reader: R, deadline: Duration, max: usize) -> Vec<u8> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(chunk[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let end = Instant::now() + deadline;
    let mut buf = Vec::new();
    loop {
        let left = end.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(chunk) => {
                buf.extend_from_slice(&chunk);
                if buf.len() >= max {
                    buf.truncate(max);
                    break;
                }
                if is_complete_json(&buf) {
                    break;
                }
            }
            // Disconnected is EOF; Timeout is the deadline.
            Err(_) => break,
        }
    }
    buf
}

/// Only an object or array counts: a bare number like `12` parses while more digits may follow.
fn is_complete_json(buf: &[u8]) -> bool {
    let trimmed = buf.trim_ascii();
    matches!(trimmed.first(), Some(b'{' | b'['))
        && serde_json::from_slice::<serde::de::IgnoredAny>(trimmed).is_ok()
}

/// Appends in the format the shell hook used: a header line, the body, a newline.
fn log(path: &std::ffi::OsStr, agent: &str, body: &[u8]) {
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let mut entry = format!("--- {} agent={agent}\n", utc_now()).into_bytes();
    entry.extend_from_slice(body);
    entry.push(b'\n');
    let _ = file.write_all(&entry);
}

fn utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    utc_iso(secs)
}

/// Formats Unix seconds as `YYYY-MM-DDTHH:MM:SSZ`, using the days-to-civil-date algorithm from
/// Howard Hinnant's date library.
fn utc_iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Yields its bytes once, then blocks forever, like an agent that never closes stdin.
    struct OpenPipe(Option<Vec<u8>>);

    impl Read for OpenPipe {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            match self.0.take() {
                Some(bytes) => {
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
                None => loop {
                    std::thread::park();
                },
            }
        }
    }

    #[test]
    fn marker_matches_constants() {
        assert_eq!(marker(), format!("{VERSION_PREFIX}{HOOK_VERSION};"));
        assert_eq!(version_in(&VERSION_MARKER), Some(HOOK_VERSION));
    }

    #[test]
    fn version_parsing() {
        assert_eq!(version_in(b"junk\0bashboard-hook-version:12;more"), Some(12));
        assert_eq!(version_in(b"no marker here"), None);
        assert_eq!(version_in(b"bashboard-hook-version:;"), None);
        assert_eq!(version_in(b"bashboard-hook-version:3x;"), None);
        assert_eq!(version_in(b"bashboard-hook-version:3"), None);
    }

    #[test]
    fn binary_name_has_platform_suffix() {
        let name = binary_name();
        assert!(name.starts_with("bashboard-hook"));
        assert_eq!(name.ends_with(".exe"), cfg!(windows));
    }

    #[test]
    fn reads_to_eof() {
        let body = read_bounded(io::Cursor::new(b"partial {".to_vec()), READ_DEADLINE, MAX_BODY);
        assert_eq!(body, b"partial {");
    }

    #[test]
    fn stops_at_the_byte_cap() {
        let body = read_bounded(io::repeat(b' '), READ_DEADLINE, 100);
        assert_eq!(body.len(), 100);
    }

    #[test]
    fn returns_early_on_a_complete_object() {
        let start = Instant::now();
        let body = read_bounded(
            OpenPipe(Some(b"{\"a\":[1,2]}\n".to_vec())),
            Duration::from_secs(10),
            MAX_BODY,
        );
        assert_eq!(body, b"{\"a\":[1,2]}\n");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn stops_at_the_deadline() {
        let start = Instant::now();
        let body = read_bounded(OpenPipe(None), Duration::from_millis(200), MAX_BODY);
        assert!(body.is_empty());
        let took = start.elapsed();
        assert!(took >= Duration::from_millis(200) && took < Duration::from_secs(2));
    }

    #[test]
    fn complete_json_detection() {
        assert!(is_complete_json(b" {\"a\":1}\r\n"));
        assert!(is_complete_json(b"[1]"));
        assert!(!is_complete_json(b"{\"a\":"));
        assert!(!is_complete_json(b"12"));
        assert!(!is_complete_json(b""));
    }

    #[test]
    fn agents_get_no_reply() {
        for agent in ["claude", "codex", "copilot"] {
            assert_eq!(reply(agent, None), None);
            assert_eq!(reply(agent, Some("PermissionRequest")), None);
        }
    }

    #[test]
    fn iso_time() {
        assert_eq!(utc_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_iso(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc_iso(1_794_484_805), "2026-11-12T12:00:05Z");
    }
}
