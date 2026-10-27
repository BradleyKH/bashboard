//! `bb`, the pane CLI (docs/design.md section 3.13). It forwards its arguments to the app's
//! hook receiver as `POST /cli`; parsing and path resolution happen in the core.

use std::io::{self, IsTerminal, Read, Write};
use std::net::TcpStream;
use std::process::ExitCode;
use std::time::Duration;

const HELP: &str = "\
bb drives the Bashboard pane it runs in.

Usage:
  bb open <path>            Show a folder in the Files pane, or a file's folder with it selected
  bb edit <path>[:<line>]   Open the file in the preferred editor
  bb git                    Open the Git pane for this folder's repo
  bb search [<query>]       Open a Search pane for this folder's repo
  bb scratch [<text>]       Open a scratch pad holding the text, or piped standard input
  bb help                   List the commands

Options:
  --collapsed               Open the new pane collapsed
";

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
        print!("{HELP}");
        return Ok(());
    };
    if is_help(command) {
        print!("{HELP}");
        return Ok(());
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
