//! `bb statusline <agent> [<command>]`, the status line side of agent usage reporting
//! (docs/design/sessions.md section 3.28). Claude Code runs the configured status line command
//! on every update and feeds it a JSON document on standard input, `rate_limits` included. This
//! wrapper posts that document to `POST /usage`, then runs the user's original command with the
//! same input so their status line is unchanged. `bb` includes this file by path, beside
//! hook_client.rs, whose bounded reader and limits it shares.

use std::io::{self, Read, Write};
use std::process::{Command, Stdio};

use crate::hook_client::{MAX_BODY, Post, READ_DEADLINE, read_bounded};

const USAGE: &str = "usage: bb statusline <claude|codex|copilot> [command]";
/// A wrapper that cannot run the command is a misuse, not the command's own failure.
const USAGE_EXIT: u8 = 2;

/// Where a pane says Bashboard listens; all empty outside a pane.
pub struct Target {
    pub url: String,
    pub token: String,
    pub pane: String,
}

impl Target {
    pub fn from_env() -> Self {
        let var = |name: &str| std::env::var(name).unwrap_or_default();
        Self {
            url: var("BASHBOARD_HOOK_URL"),
            token: var("BASHBOARD_HOOK_TOKEN"),
            pane: var("BASHBOARD_PANE_ID"),
        }
    }
}

/// The agent and, when given, the wrapped command. The command is one argument so the user's
/// original string round-trips exactly into `sh -c`.
fn parse(args: &[String]) -> Result<(&str, Option<&str>), &'static str> {
    match args {
        [agent] => Ok((agent, None)),
        [agent, command] => Ok((agent, Some(command))),
        _ => Err(USAGE),
    }
}

pub fn run(args: &[String], post: Post) -> u8 {
    run_with(args, io::stdin(), &Target::from_env(), post, &mut io::stdout())
}

/// Posts the input to Bashboard, then runs the command. Returns the command's exit code, or 0
/// when there is none: a failing wrapper would blank the user's status line, and Bashboard
/// being away is not an error.
fn run_with<R: Read + Send + 'static>(
    args: &[String],
    input: R,
    target: &Target,
    post: Post,
    out: &mut dyn Write,
) -> u8 {
    let (agent, command) = match parse(args) {
        Ok(parsed) => parsed,
        Err(usage) => {
            eprintln!("{usage}");
            return USAGE_EXIT;
        }
    };
    let posting = !target.url.is_empty();
    // With nothing to report and nothing to wrap, stdin is none of our business.
    if !posting && command.is_none() {
        return 0;
    }
    let body = read_bounded(input, READ_DEADLINE, MAX_BODY);
    // The receiver answers 400 to an empty body, so skipping it spares a connect wait.
    if posting && !body.trim_ascii().is_empty() {
        let headers = [
            ("X-Bashboard-Token", target.token.as_str()),
            ("X-Bashboard-Pane", target.pane.as_str()),
            ("X-Bashboard-Agent", agent),
        ];
        post(&target.url, &headers, &body);
    }
    match command {
        Some(command) => run_command(command, &body, out),
        None => 0,
    }
}

/// Holds the command for the shell to `eval`. On Windows an argument reaches an MSYS `sh`
/// through its own command line parser, which collapses doubled backslashes; the environment
/// arrives verbatim.
const COMMAND_VAR: &str = "BASHBOARD_STATUSLINE_COMMAND";

/// On Windows a bare `bash` can resolve to WSL's, which runs nothing of Git Bash's.
#[cfg(windows)]
const SHELLS: [&str; 1] = ["sh"];
#[cfg(not(windows))]
const SHELLS: [&str; 2] = ["sh", "bash"];

/// Runs `command` through `sh`, falling back to `bash` off Windows when `sh` is not on PATH, with
/// `input` on its standard input; its standard output is copied to `out` and its exit code
/// returned. Standard error is inherited.
fn run_command(command: &str, input: &[u8], out: &mut dyn Write) -> u8 {
    let mut child = None;
    for shell in SHELLS {
        match Command::new(shell)
            .args(["-c", &format!("eval \"${COMMAND_VAR}\"")])
            .env(COMMAND_VAR, command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
        {
            Ok(spawned) => {
                child = Some(spawned);
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => {
                eprintln!("bb statusline: could not run {shell}: {e}");
                return 1;
            }
        }
    }
    let Some(mut child) = child else {
        eprintln!("bb statusline: no {} on PATH", SHELLS.join(" or "));
        return 1;
    };
    // A thread, so a command that never reads its input cannot deadlock us against a full
    // pipe; it ends when the command exits or closes stdin.
    let feeder = child.stdin.take().map(|mut stdin| {
        let input = input.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        })
    });
    let output = child.wait_with_output();
    if let Some(feeder) = feeder {
        let _ = feeder.join();
    }
    match output {
        Ok(output) => {
            let _ = out.write_all(&output.stdout);
            let _ = out.flush();
            // Windows codes can exceed a byte, and a signal leaves none; neither is a success.
            output.status.code().map_or(1, |c| u8::try_from(c).unwrap_or(1))
        }
        Err(e) => {
            eprintln!("bb statusline: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::time::{Duration, Instant};

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    fn target(url: &str) -> Target {
        Target { url: url.into(), token: "tok".into(), pane: "p1".into() }
    }

    fn shell_available() -> bool {
        ["sh", "bash"].iter().any(|s| {
            Command::new(s)
                .args(["-c", "true"])
                .status()
                .is_ok_and(|st| st.success())
        })
    }

    #[test]
    fn splits_agent_and_one_command_argument() {
        let args = strings(&["claude", "node \"a b\" | jq ."]);
        assert_eq!(parse(&args), Ok(("claude", Some("node \"a b\" | jq ."))));
        assert_eq!(parse(&strings(&["codex"])), Ok(("codex", None)));
        assert!(parse(&strings(&[])).is_err());
        assert!(parse(&strings(&["claude", "node", "script.js"])).is_err());
    }

    #[test]
    fn no_command_prints_nothing_and_posts_the_input() {
        let posted = RefCell::new(Vec::new());
        let post = |url: &str, headers: &[(&str, &str)], body: &[u8]| {
            posted.borrow_mut().push((
                url.to_string(),
                headers.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>(),
                body.to_vec(),
            ));
        };
        let mut out = Vec::new();
        let code = run_with(
            &strings(&["claude"]),
            io::Cursor::new(b"{\"a\":1}".to_vec()),
            &target("http://127.0.0.1:9"),
            &post,
            &mut out,
        );
        assert_eq!(code, 0);
        assert!(out.is_empty());
        let posted = posted.borrow();
        assert_eq!(posted.len(), 1);
        assert_eq!(posted[0].0, "http://127.0.0.1:9");
        assert_eq!(
            posted[0].1,
            ["X-Bashboard-Token=tok", "X-Bashboard-Pane=p1", "X-Bashboard-Agent=claude"]
        );
        assert_eq!(posted[0].2, b"{\"a\":1}");
    }

    #[test]
    fn outside_a_pane_nothing_is_posted_and_stdin_is_untouched() {
        let post = |_: &str, _: &[(&str, &str)], _: &[u8]| panic!("must not post");
        let mut out = Vec::new();
        // A reader that would hang proves stdin is never read without a command.
        struct Hang;
        impl Read for Hang {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                loop {
                    std::thread::park();
                }
            }
        }
        let start = Instant::now();
        assert_eq!(run_with(&strings(&["claude"]), Hang, &target(""), &post, &mut out), 0);
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn empty_input_is_not_posted() {
        let post = |_: &str, _: &[(&str, &str)], _: &[u8]| panic!("must not post");
        let mut out = Vec::new();
        let code = run_with(
            &strings(&["claude"]),
            io::Cursor::new(b"  \n".to_vec()),
            &target("http://127.0.0.1:9"),
            &post,
            &mut out,
        );
        assert_eq!(code, 0);
    }

    #[test]
    fn wrapped_command_gets_the_input_and_its_output_and_code_pass_through() {
        if !shell_available() {
            return;
        }
        let post = |_: &str, _: &[(&str, &str)], _: &[u8]| {};
        let mut out = Vec::new();
        let code = run_with(
            &strings(&["claude", "cat; echo \"tail  two\"; exit 3"]),
            io::Cursor::new(b"{\"rate_limits\":{}}".to_vec()),
            &target(""),
            &post,
            &mut out,
        );
        assert_eq!(code, 3);
        assert_eq!(String::from_utf8_lossy(&out).replace("\r\n", "\n"), "{\"rate_limits\":{}}tail  two\n");
    }

    #[test]
    fn a_command_that_ignores_its_input_does_not_hang() {
        if !shell_available() {
            return;
        }
        let post = |_: &str, _: &[(&str, &str)], _: &[u8]| {};
        let mut out = Vec::new();
        let big = format!("{{\"pad\":\"{}\"}}", "x".repeat(60_000));
        let start = Instant::now();
        let code = run_with(
            &strings(&["claude", "echo hi"]),
            io::Cursor::new(big.into_bytes()),
            &target(""),
            &post,
            &mut out,
        );
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8_lossy(&out).trim(), "hi");
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_command_reaches_the_shell_verbatim() {
        if !shell_available() {
            return;
        }
        let post = |_: &str, _: &[(&str, &str)], _: &[u8]| {};
        let text = r#"a \\ b "c\\" C:\Users\me\x.sh it's $HOME"#;
        let command = format!("printf %s '{}'", text.replace('\'', r"'\''"));
        let mut out = Vec::new();
        let code = run_with(
            &strings(&["claude", &command]),
            io::Cursor::new(Vec::new()),
            &target(""),
            &post,
            &mut out,
        );
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8_lossy(&out), text);
    }
}
