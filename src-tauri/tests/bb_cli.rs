//! Runs the `bb` binary against a stand-in receiver and checks what it posts and how it reports
//! each answer.

use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;

use tiny_http::{Header, Response, Server};

struct Posted {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: serde_json::Value,
}

impl Posted {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Serves one request with `status` and `body`, returning its URL and what the server saw.
fn serve_once(status: u16, body: &'static str) -> (String, mpsc::Receiver<Posted>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut req = server.recv().unwrap();
        let mut raw = String::new();
        req.as_reader().read_to_string(&mut raw).unwrap();
        let posted = Posted {
            method: req.method().to_string(),
            url: req.url().to_string(),
            headers: req
                .headers()
                .iter()
                .map(|h| (h.field.to_string(), h.value.to_string()))
                .collect(),
            body: serde_json::from_str(&raw).unwrap(),
        };
        let response = if body.is_empty() {
            Response::from_string("").with_status_code(status)
        } else {
            Response::from_string(body)
                .with_status_code(status)
                .with_header(Header::from_bytes(b"Content-Type", b"application/json").unwrap())
        };
        req.respond(response).unwrap();
        tx.send(posted).unwrap();
    });
    (format!("http://127.0.0.1:{port}"), rx)
}

fn bb(url: Option<&str>, args: &[&str], stdin: Option<&str>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bb"));
    cmd.args(args)
        .env("BASHBOARD_HOOK_TOKEN", "secret")
        .env("BASHBOARD_PANE_ID", "7")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match url {
        Some(u) => cmd.env("BASHBOARD_HOOK_URL", u),
        None => cmd.env_remove("BASHBOARD_HOOK_URL"),
    };
    let mut child = cmd.spawn().unwrap();
    let mut pipe = child.stdin.take().unwrap();
    if let Some(text) = stdin {
        pipe.write_all(text.as_bytes()).unwrap();
    }
    drop(pipe);
    child.wait_with_output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn git_posts_the_request() {
    let (url, rx) = serve_once(204, "");
    let out = bb(Some(&url), &["git", "--collapsed"], None);
    assert!(out.status.success(), "stderr: {}", text(&out.stderr));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());

    let posted = rx.recv().unwrap();
    assert_eq!(posted.method, "POST");
    assert_eq!(posted.url, "/cli");
    assert_eq!(posted.header("X-Bashboard-Token"), Some("secret"));
    assert_eq!(posted.header("X-Bashboard-Pane"), Some("7"));
    assert_eq!(posted.header("Content-Type"), Some("application/json"));
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        posted.body,
        serde_json::json!({ "command": "git", "args": ["--collapsed"], "cwd": cwd })
    );
}

#[test]
fn piped_scratch_carries_stdin() {
    let (url, rx) = serve_once(204, "");
    let out = bb(Some(&url), &["scratch"], Some("diff --git a b\n"));
    assert!(out.status.success(), "stderr: {}", text(&out.stderr));
    let posted = rx.recv().unwrap();
    assert_eq!(posted.body["command"], "scratch");
    assert_eq!(posted.body["stdin"], "diff --git a b\n");
}

#[test]
fn scratch_with_text_has_no_stdin() {
    let (url, rx) = serve_once(204, "");
    let out = bb(Some(&url), &["scratch", "hello"], Some("ignored"));
    assert!(out.status.success(), "stderr: {}", text(&out.stderr));
    let posted = rx.recv().unwrap();
    assert_eq!(posted.body["args"], serde_json::json!(["hello"]));
    assert!(posted.body.get("stdin").is_none());
}

#[test]
fn bad_request_prints_the_error() {
    let (url, _rx) = serve_once(400, r#"{ "error": "no such file" }"#);
    let out = bb(Some(&url), &["open", "missing.txt"], None);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(text(&out.stderr).trim(), "bb: no such file");
    assert!(out.stdout.is_empty());
}

#[test]
fn rejected_token_fails() {
    let (url, _rx) = serve_once(403, "");
    let out = bb(Some(&url), &["git"], None);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(text(&out.stderr).trim(), "bb: Bashboard rejected the token");
}

#[test]
fn outside_the_app_fails() {
    let out = bb(None, &["git"], None);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        text(&out.stderr).trim(),
        "bb: only works inside a Bashboard pane"
    );
}

#[test]
fn help_needs_no_app() {
    for args in [&["help"][..], &[][..], &["--help"][..]] {
        let out = bb(None, args, None);
        assert!(out.status.success());
        let help = text(&out.stdout);
        for cmd in [
            "bb open",
            "bb edit",
            "bb git",
            "bb search",
            "bb scratch",
            "--collapsed",
        ] {
            assert!(help.contains(cmd), "help lacks {cmd}");
        }
    }
}

#[test]
fn unreachable_app_fails() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let out = bb(Some(&format!("http://127.0.0.1:{port}")), &["git"], None);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out.stderr).starts_with("bb: could not reach Bashboard: "));
}
