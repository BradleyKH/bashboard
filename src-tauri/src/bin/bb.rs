//! `bb`, the pane CLI (docs/design.md section 3.13). It forwards its arguments to the app's
//! hook receiver as `POST /cli`; parsing and path resolution happen in the core.

use std::io::{self, IsTerminal, Read, Write};
use std::net::TcpStream;
use std::process::ExitCode;
use std::time::Duration;

// The reader and `exists` serve the app only.
#[allow(dead_code, unused_imports)]
#[path = "../credential_store.rs"]
mod credential_store;

use credential_store::{AZURE_DEVOPS_USER, BITBUCKET_TARGET, BITBUCKET_USER, clean_token};

/// The command reference, shared with the app dialog's CLI tab.
const REFERENCE: &str = include_str!("../../cli-commands.json");

#[derive(serde::Deserialize)]
struct Reference {
    intro: String,
    commands: Vec<Entry>,
    options: Vec<Entry>,
}

#[derive(serde::Deserialize)]
struct Entry {
    usage: String,
    summary: String,
}

fn help_text() -> String {
    let r: Reference = serde_json::from_str(REFERENCE).expect("cli-commands.json is valid");
    let line = |e: &Entry| format!("  {:<28}{}\n", e.usage, e.summary);
    let mut text = format!("{}\n\nUsage:\n", r.intro);
    r.commands.iter().for_each(|e| text.push_str(&line(e)));
    text.push_str("\nOptions:\n");
    r.options.iter().for_each(|e| text.push_str(&line(e)));
    text
}

const MAX_STDIN: u64 = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("bb: {msg}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let Some((command, rest)) = args.split_first() else {
        print!("{}", help_text());
        return Ok(());
    };
    if is_help(command) {
        print!("{}", help_text());
        return Ok(());
    }
    // Talks only to Credential Manager, so it works outside a pane too.
    if command == "auth" {
        return auth(rest);
    }
    let url = std::env::var("BASHBOARD_HOOK_URL").unwrap_or_default();
    if url.is_empty() {
        return Err("only works inside a Bashboard pane".into());
    }
    let token = std::env::var("BASHBOARD_HOOK_TOKEN").unwrap_or_default();
    let pane = std::env::var("BASHBOARD_PANE_ID").unwrap_or_default();
    let cwd = std::env::current_dir()
        .map_err(|e| format!("no working directory: {e}"))?
        .to_string_lossy()
        .into_owned();

    let stdin = if wants_stdin(command, rest) && !io::stdin().is_terminal() {
        Some(read_stdin()?)
    } else {
        None
    };
    let body = request_body(command, rest, &cwd, stdin.as_deref());
    let addr = parse_url(&url)?;
    let request = build_request(&addr, &token, &pane, &body);
    let response = send(&addr, &request).map_err(|e| format!("could not reach Bashboard: {e}"))?;
    answer(&response)
}

fn is_help(command: &str) -> bool {
    matches!(command, "help" | "-h" | "--help")
}

/// Standard input feeds `scratch` only when no text was given on the command line.
fn wants_stdin(command: &str, rest: &[String]) -> bool {
    command == "scratch" && rest.iter().all(|a| a == "--collapsed")
}

fn read_stdin() -> Result<String, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_STDIN + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read standard input: {e}"))?;
    if bytes.len() as u64 > MAX_STDIN {
        return Err("input is over 1 MiB".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Debug, PartialEq)]
enum AuthAction {
    Store,
    Clear,
}

#[derive(Debug, PartialEq)]
enum AuthProvider {
    Bitbucket,
    /// The organization as typed; its credential target is built by `azure_devops_target`.
    AzureDevOps(String),
}

const AUTH_USAGE: &str =
    "usage: bb auth bitbucket [--clear] | bb auth azure-devops <org> [--clear]";

fn parse_flags(flags: &[String]) -> Result<AuthAction, String> {
    match flags {
        [] => Ok(AuthAction::Store),
        [f] if f == "--clear" => Ok(AuthAction::Clear),
        _ => Err(AUTH_USAGE.into()),
    }
}

fn parse_auth(rest: &[String]) -> Result<(AuthProvider, AuthAction), String> {
    let Some((provider, args)) = rest.split_first() else {
        return Err(AUTH_USAGE.into());
    };
    match provider.as_str() {
        "bitbucket" => Ok((AuthProvider::Bitbucket, parse_flags(args)?)),
        "azure-devops" => {
            // A leading dash is a flag in the wrong place, not an organization.
            let Some((org, flags)) = args.split_first().filter(|(o, _)| !o.starts_with('-'))
            else {
                return Err(AUTH_USAGE.into());
            };
            credential_store::azure_devops_target(org)?;
            Ok((AuthProvider::AzureDevOps(org.clone()), parse_flags(flags)?))
        }
        other => Err(format!("unknown provider \"{other}\" ({AUTH_USAGE})")),
    }
}

fn auth(rest: &[String]) -> Result<(), String> {
    let (provider, action) = parse_auth(rest)?;
    let (target, user, prompt) = match &provider {
        AuthProvider::Bitbucket => (
            BITBUCKET_TARGET.to_string(),
            BITBUCKET_USER,
            "Bitbucket API token: ".to_string(),
        ),
        AuthProvider::AzureDevOps(org) => (
            credential_store::azure_devops_target(org)?,
            AZURE_DEVOPS_USER,
            format!("Azure DevOps PAT for {org}: "),
        ),
    };
    match action {
        AuthAction::Clear => {
            if credential_store::delete(&target)? {
                println!("{}", removed_message(&provider));
            } else {
                println!("{}", not_stored_message(&provider));
            }
        }
        AuthAction::Store => {
            let token = clean_token(&read_secret(&prompt)?)?;
            credential_store::write(&target, user, token.as_bytes())?;
            println!("{}", stored_message(&provider));
        }
    }
    Ok(())
}

fn stored_message(provider: &AuthProvider) -> String {
    match provider {
        AuthProvider::Bitbucket => {
            "Stored the Bitbucket token in Windows Credential Manager.".into()
        }
        AuthProvider::AzureDevOps(org) => {
            format!("Stored the Azure DevOps token for {org} in Windows Credential Manager.")
        }
    }
}

fn removed_message(provider: &AuthProvider) -> String {
    match provider {
        AuthProvider::Bitbucket => "Removed the stored Bitbucket token.".into(),
        AuthProvider::AzureDevOps(org) => {
            format!("Removed the stored Azure DevOps token for {org}.")
        }
    }
}

fn not_stored_message(provider: &AuthProvider) -> String {
    match provider {
        AuthProvider::Bitbucket => "No Bitbucket token was stored.".into(),
        AuthProvider::AzureDevOps(org) => format!("No Azure DevOps token was stored for {org}."),
    }
}

/// Reads one line with console echo off, or standard input when it is not a terminal.
fn read_secret(prompt: &str) -> Result<String, String> {
    let mut input = String::new();
    if io::stdin().is_terminal() {
        eprint!("{prompt}");
        let _ = io::stderr().flush();
        let guard = console::EchoOff::new();
        let read = io::stdin().read_line(&mut input);
        drop(guard);
        eprintln!();
        read.map_err(|e| format!("could not read the token: {e}"))?;
    } else {
        let mut bytes = Vec::new();
        io::stdin()
            .lock()
            .take(MAX_STDIN + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("could not read standard input: {e}"))?;
        input = String::from_utf8_lossy(&bytes).into_owned();
    }
    Ok(input)
}

#[cfg(windows)]
mod console {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        CONSOLE_MODE, ENABLE_ECHO_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE,
        SetConsoleMode,
    };

    /// Turns console echo off for standard input and restores the old mode on drop, so an
    /// early return never leaves the terminal silent.
    pub struct EchoOff {
        handle: HANDLE,
        mode: Option<CONSOLE_MODE>,
    }

    impl EchoOff {
        pub fn new() -> Self {
            // SAFETY: plain console queries on the process's own input handle.
            unsafe {
                let handle = GetStdHandle(STD_INPUT_HANDLE).unwrap_or_default();
                let mut mode = CONSOLE_MODE(0);
                if GetConsoleMode(handle, &mut mode).is_err() {
                    return Self { handle, mode: None };
                }
                let quiet = CONSOLE_MODE(mode.0 & !ENABLE_ECHO_INPUT.0);
                let changed = SetConsoleMode(handle, quiet).is_ok();
                Self {
                    handle,
                    mode: changed.then_some(mode),
                }
            }
        }
    }

    impl Drop for EchoOff {
        fn drop(&mut self) {
            if let Some(mode) = self.mode {
                // SAFETY: restores the mode read in `new` on the same handle.
                unsafe {
                    let _ = SetConsoleMode(self.handle, mode);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod console {
    pub struct EchoOff;

    impl EchoOff {
        pub fn new() -> Self {
            Self
        }
    }
}

fn request_body(command: &str, rest: &[String], cwd: &str, stdin: Option<&str>) -> Vec<u8> {
    let mut body = serde_json::json!({ "command": command, "args": rest, "cwd": cwd });
    if let Some(text) = stdin {
        body["stdin"] = text.into();
    }
    serde_json::to_vec(&body).expect("a JSON value serializes")
}

/// Returns `host:port` from the `http://127.0.0.1:<port>` URL the core hands each pane.
fn parse_url(url: &str) -> Result<String, String> {
    let bad = || format!("bad BASHBOARD_HOOK_URL: {url}");
    let rest = url.strip_prefix("http://").ok_or_else(bad)?;
    let addr = rest.trim_end_matches('/');
    let (host, port) = addr.rsplit_once(':').ok_or_else(bad)?;
    if host.is_empty() || host.contains('/') || port.parse::<u16>().is_err() {
        return Err(bad());
    }
    Ok(addr.to_string())
}

fn build_request(addr: &str, token: &str, pane: &str, body: &[u8]) -> Vec<u8> {
    let mut req = format!(
        "POST /cli HTTP/1.1\r\n\
         Host: {addr}\r\n\
         X-Bashboard-Token: {token}\r\n\
         X-Bashboard-Pane: {pane}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    req.extend_from_slice(body);
    req
}

fn send(addr: &str, request: &[u8]) -> io::Result<Vec<u8>> {
    let mut stream = TcpStream::connect(addr)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    stream.set_write_timeout(Some(TIMEOUT))?;
    stream.write_all(request)?;
    let mut response = Vec::new();
    match stream.read_to_end(&mut response) {
        // A server that keeps the socket open past its answer still gave one.
        Err(_) if parse_response(&response).is_some() => Ok(response),
        Err(e) => Err(e),
        Ok(_) => Ok(response),
    }
}

/// Splits a raw HTTP response into its status code and body.
fn parse_response(raw: &[u8]) -> Option<(u16, &[u8])> {
    let line_end = raw.windows(2).position(|w| w == b"\r\n")?;
    let line = std::str::from_utf8(&raw[..line_end]).ok()?;
    let mut parts = line.split(' ');
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    let status = parts.next()?.parse().ok()?;
    let body = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map_or(&raw[raw.len()..], |i| &raw[i + 4..]);
    Some((status, body))
}

fn answer(raw: &[u8]) -> Result<(), String> {
    let (status, body) = parse_response(raw).ok_or("Bashboard sent an unreadable answer")?;
    match status {
        204 => Ok(()),
        400 => Err(error_text(body)),
        403 => Err("Bashboard rejected the token".into()),
        404 => Err("this pane is not known to Bashboard".into()),
        413 => Err("input is over 1 MiB".into()),
        other => Err(format!("Bashboard answered {other}")),
    }
}

fn error_text(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn help_lists_every_command() {
        let text = help_text();
        for name in [
            "open",
            "edit",
            "git",
            "search",
            "scratch",
            "auth",
            "help",
            "--collapsed",
        ] {
            assert!(text.contains(name), "{name} missing from help");
        }
        assert!(text.contains("  bb edit <path>[:<line>]     Open the file"));
    }

    #[test]
    fn auth_arguments() {
        use AuthAction::{Clear, Store};
        use AuthProvider::{AzureDevOps, Bitbucket};
        assert_eq!(
            parse_auth(&strings(&["bitbucket"])),
            Ok((Bitbucket, Store))
        );
        assert_eq!(
            parse_auth(&strings(&["bitbucket", "--clear"])),
            Ok((Bitbucket, Clear))
        );
        assert_eq!(
            parse_auth(&strings(&["azure-devops", "Contoso"])),
            Ok((AzureDevOps("Contoso".into()), Store))
        );
        assert_eq!(
            parse_auth(&strings(&["azure-devops", "contoso", "--clear"])),
            Ok((AzureDevOps("contoso".into()), Clear))
        );
        assert_eq!(parse_auth(&[]).unwrap_err(), AUTH_USAGE);
        // A missing organization, a bad one, and bad flags all fail with the usage or a reason.
        assert_eq!(parse_auth(&strings(&["azure-devops"])).unwrap_err(), AUTH_USAGE);
        assert_eq!(
            parse_auth(&strings(&["azure-devops", "--clear"])).unwrap_err(),
            AUTH_USAGE
        );
        assert!(parse_auth(&strings(&["azure-devops", "a/b"])).is_err());
        assert!(parse_auth(&strings(&["azure-devops", "a b"])).is_err());
        assert!(parse_auth(&strings(&["azure-devops", "contoso", "--wat"])).is_err());
        assert!(parse_auth(&strings(&["azure-devops", "contoso", "--clear", "x"])).is_err());
        assert!(parse_auth(&strings(&["azure-devops", "--clear", "contoso"])).is_err());
        assert!(
            parse_auth(&strings(&["github"]))
                .unwrap_err()
                .contains("unknown provider")
        );
        assert!(parse_auth(&strings(&["bitbucket", "--wat"])).is_err());
        assert!(parse_auth(&strings(&["bitbucket", "--clear", "x"])).is_err());
    }

    #[test]
    fn help_forms() {
        for h in ["help", "-h", "--help"] {
            assert!(is_help(h));
        }
        assert!(!is_help("git"));
    }

    #[test]
    fn stdin_only_for_bare_scratch() {
        assert!(wants_stdin("scratch", &[]));
        assert!(wants_stdin("scratch", &strings(&["--collapsed"])));
        assert!(!wants_stdin("scratch", &strings(&["hello"])));
        assert!(!wants_stdin("scratch", &strings(&["--collapsed", "hello"])));
        assert!(!wants_stdin("git", &[]));
    }

    #[test]
    fn url_parsing() {
        assert_eq!(
            parse_url("http://127.0.0.1:5123").unwrap(),
            "127.0.0.1:5123"
        );
        assert_eq!(
            parse_url("http://127.0.0.1:5123/").unwrap(),
            "127.0.0.1:5123"
        );
        assert!(parse_url("https://127.0.0.1:5123").is_err());
        assert!(parse_url("http://127.0.0.1").is_err());
        assert!(parse_url("http://127.0.0.1:notaport").is_err());
        assert!(parse_url("http://:5123").is_err());
        assert!(parse_url("http://127.0.0.1:5123/hook").is_err());
    }

    #[test]
    fn body_shape() {
        let body = request_body("open", &strings(&["src", "--collapsed"]), r"C:\repo", None);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "command": "open", "args": ["src", "--collapsed"], "cwd": r"C:\repo" })
        );
        let body = request_body("scratch", &[], r"C:\repo", Some("hi\n"));
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["stdin"], "hi\n");
        assert_eq!(v["args"], serde_json::json!([]));
    }

    #[test]
    fn request_text() {
        let req = build_request("127.0.0.1:9", "tok", "3", b"{}");
        let text = String::from_utf8(req).unwrap();
        assert!(text.starts_with("POST /cli HTTP/1.1\r\n"));
        assert!(text.contains("\r\nX-Bashboard-Token: tok\r\n"));
        assert!(text.contains("\r\nX-Bashboard-Pane: 3\r\n"));
        assert!(text.contains("\r\nContent-Type: application/json\r\n"));
        assert!(text.contains("\r\nContent-Length: 2\r\n"));
        assert!(text.ends_with("\r\nConnection: close\r\n\r\n{}"));
    }

    #[test]
    fn response_parsing() {
        let (status, body) = parse_response(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
        assert_eq!((status, body), (204, &b""[..]));
        let raw = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 9\r\n\r\n{\"a\":1}\r\n";
        assert_eq!(parse_response(raw).unwrap().1, b"{\"a\":1}\r\n");
        assert!(parse_response(b"garbage").is_none());
        assert!(parse_response(b"FTP 200 ok\r\n\r\n").is_none());
    }

    #[test]
    fn answers() {
        assert!(answer(b"HTTP/1.1 204 No Content\r\n\r\n").is_ok());
        let e =
            answer(b"HTTP/1.1 400 Bad Request\r\n\r\n{\"error\":\"no such file\"}").unwrap_err();
        assert_eq!(e, "no such file");
        let e = answer(b"HTTP/1.1 400 Bad Request\r\n\r\nplain words\n").unwrap_err();
        assert_eq!(e, "plain words");
        assert_eq!(
            answer(b"HTTP/1.1 403 Forbidden\r\n\r\n").unwrap_err(),
            "Bashboard rejected the token"
        );
        assert_eq!(
            answer(b"HTTP/1.1 404 Not Found\r\n\r\n").unwrap_err(),
            "this pane is not known to Bashboard"
        );
        assert_eq!(
            answer(b"HTTP/1.1 413 Too Large\r\n\r\n").unwrap_err(),
            "input is over 1 MiB"
        );
        assert_eq!(
            answer(b"HTTP/1.1 500 Oops\r\n\r\n").unwrap_err(),
            "Bashboard answered 500"
        );
    }
}
