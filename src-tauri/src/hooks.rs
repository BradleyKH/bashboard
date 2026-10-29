//! Loopback hook receiver (design sections 3.3 and 3.4): Claude Code hooks post their JSON
//! payload here, and the latest status per session is kept as an overlay on the roster. The
//! same receiver takes `POST /cli` from the `bb` pane CLI (design section 3.13) and emits the
//! resolved command as `cli://command`.

use std::{
    collections::{HashMap, HashSet},
    io::Read,
    sync::{Mutex, OnceLock},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server, StatusCode};

use crate::{cli, pty::Ptys, roster};

const MAX_BODY: usize = 64 * 1024;
const MAX_CLI_BODY: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookStatus {
    Busy,
    Idle,
    Waiting,
}

/// What hooks have said about one session. Times are receive times in epoch ms; `last_at` is
/// the newest event of any kind.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookOverlay {
    pub status: Option<(HookStatus, u64)>,
    pub pane_id: Option<u32>,
    pub last_at: u64,
}

/// One accepted hook post, as emitted on `sessions://hook`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    pub session_id: String,
    pub hook_event_name: String,
    pub cwd: Option<String>,
    pub message: Option<String>,
    pub notification_type: Option<String>,
    pub pane_id: Option<u32>,
    pub at: u64,
}

#[derive(Default)]
pub struct Hooks {
    /// URL and token; unset when the server could not bind.
    endpoint: OnceLock<(String, String)>,
    overlay: Mutex<HashMap<String, HookOverlay>>,
}

/// How long an entry for a session the roster does not list is kept, since a hook can arrive
/// before its session file.
const ORPHAN_TTL_MS: u64 = 60_000;

impl Hooks {
    pub fn url(&self) -> Option<&str> {
        self.endpoint.get().map(|(url, _)| url.as_str())
    }

    pub fn token(&self) -> Option<&str> {
        self.endpoint.get().map(|(_, token)| token.as_str())
    }

    pub fn overlay(&self) -> HashMap<String, HookOverlay> {
        self.overlay.lock().unwrap().clone()
    }

    pub fn prune(&self, live: &HashSet<&str>, now: u64) {
        prune(&mut self.overlay.lock().unwrap(), live, now);
    }
}

fn prune(overlay: &mut HashMap<String, HookOverlay>, live: &HashSet<&str>, now: u64) {
    overlay.retain(|id, o| live.contains(id.as_str()) || now.saturating_sub(o.last_at) < ORPHAN_TTL_MS);
}

pub fn init(app: &AppHandle) {
    let token = match new_token() {
        Ok(t) => t,
        Err(e) => {
            eprintln!("hooks: no random token, receiver disabled: {e}");
            return;
        }
    };
    let server = match Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("hooks: could not bind receiver: {e}");
            return;
        }
    };
    let Some(addr) = server.server_addr().to_ip() else {
        eprintln!("hooks: receiver has no IP address");
        return;
    };
    let url = format!("http://127.0.0.1:{}", addr.port());
    let _ = app.state::<Hooks>().endpoint.set((url, token.clone()));

    let app = app.clone();
    thread::spawn(move || {
        serve(
            &server,
            &token,
            |ev| {
                apply(&mut app.state::<Hooks>().overlay.lock().unwrap(), &ev);
                let _ = app.emit("sessions://hook", ev);
                roster::refresh(&app);
            },
            |id| app.state::<Ptys>().contains(id),
            |cmd| {
                let _ = app.emit("cli://command", cmd);
            },
        )
    });
}

fn new_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn header<'a>(headers: &'a [Header], name: &'static str) -> Option<&'a str> {
    headers.iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

/// Answers requests until the server shuts down, passing each accepted hook event to
/// `on_event` and each accepted `/cli` command to `on_cli`. `pane_live` says whether a pty id
/// belongs to a running pane. Nothing here waits on the front end.
fn serve(
    server: &Server,
    token: &str,
    mut on_event: impl FnMut(HookEvent),
    pane_live: impl Fn(u32) -> bool,
    mut on_cli: impl FnMut(cli::CliCommand),
) {
    for mut req in server.incoming_requests() {
        let is_cli = req.url().split('?').next() == Some("/cli");
        let cap = if is_cli { MAX_CLI_BODY } else { MAX_BODY };
        let content_length = req.body_length();
        let mut body = Vec::new();
        // An oversized declared length is rejected without reading; otherwise read one byte
        // past the cap so an undeclared or understated length still trips the limit.
        if content_length.is_none_or(|n| n <= cap) {
            let _ = req.as_reader().take(cap as u64 + 1).read_to_end(&mut body);
        }
        if is_cli {
            let (code, error, cmd) = handle_cli(
                token,
                req.method(),
                header(req.headers(), "X-Bashboard-Token"),
                header(req.headers(), "X-Bashboard-Pane"),
                &body,
                content_length,
                &pane_live,
            );
            if let Some(cmd) = cmd {
                on_cli(cmd);
            }
            let _ = match error {
                Some(json) => {
                    let mut resp = Response::from_string(json).with_status_code(StatusCode(code));
                    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
                        resp.add_header(h);
                    }
                    req.respond(resp)
                }
                None => req.respond(Response::empty(StatusCode(code))),
            };
            continue;
        }
        let (code, ev) = handle(
            token,
            req.method(),
            req.url(),
            header(req.headers(), "X-Bashboard-Token"),
            header(req.headers(), "X-Bashboard-Pane"),
            &body,
            content_length,
            now_ms(),
        );
        if let Some(ev) = ev {
            on_event(ev);
        }
        let _ = req.respond(Response::empty(StatusCode(code)));
    }
}

/// Equal-length strings are compared without early exit so timing does not reveal a prefix.
fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[allow(clippy::too_many_arguments)]
fn handle(
    token: &str,
    method: &Method,
    url: &str,
    token_header: Option<&str>,
    pane_header: Option<&str>,
    body: &[u8],
    content_length: Option<usize>,
    now: u64,
) -> (u16, Option<HookEvent>) {
    let path = url.split('?').next().unwrap_or("");
    if *method != Method::Post || path != "/hook" {
        return (404, None);
    }
    if !token_header.is_some_and(|t| token_matches(token, t)) {
        return (403, None);
    }
    if content_length.is_some_and(|n| n > MAX_BODY) || body.len() > MAX_BODY {
        return (413, None);
    }
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(body) else {
        return (400, None);
    };
    let field = |name: &str| json.get(name).and_then(|v| v.as_str()).map(str::to_owned);
    let Some(session_id) = field("session_id") else {
        return (400, None);
    };
    let ev = HookEvent {
        session_id,
        hook_event_name: field("hook_event_name").unwrap_or_default(),
        cwd: field("cwd"),
        message: field("message"),
        notification_type: field("notification_type"),
        pane_id: pane_header.and_then(|p| p.trim().parse().ok()),
        at: now,
    };
    (204, Some(ev))
}

/// Answers `POST /cli`: status, a JSON body for a 400, and the resolved command on success.
/// Unlike `/hook`, the pane header is required and must name a live pty.
fn handle_cli(
    token: &str,
    method: &Method,
    token_header: Option<&str>,
    pane_header: Option<&str>,
    body: &[u8],
    content_length: Option<usize>,
    pane_live: &impl Fn(u32) -> bool,
) -> (u16, Option<String>, Option<cli::CliCommand>) {
    if *method != Method::Post {
        return (404, None, None);
    }
    if !token_header.is_some_and(|t| token_matches(token, t)) {
        return (403, None, None);
    }
    let pty_id = pane_header.and_then(|p| p.trim().parse::<u32>().ok()).filter(|&id| pane_live(id));
    let Some(pty_id) = pty_id else {
        return (404, None, None);
    };
    if content_length.is_some_and(|n| n > MAX_CLI_BODY) || body.len() > MAX_CLI_BODY {
        return (413, None, None);
    }
    match cli::parse(body, pty_id) {
        Ok(cmd) => (204, None, Some(cmd)),
        Err(msg) => (400, Some(serde_json::json!({ "error": msg }).to_string()), None),
    }
}

/// Folds one event into the overlay (design section 7).
fn apply(overlay: &mut HashMap<String, HookOverlay>, ev: &HookEvent) {
    if ev.hook_event_name == "SessionEnd" {
        overlay.remove(&ev.session_id);
        return;
    }
    let entry = overlay.entry(ev.session_id.clone()).or_default();
    entry.last_at = ev.at;
    let status = match ev.hook_event_name.as_str() {
        "UserPromptSubmit" => Some(HookStatus::Busy),
        "Notification" if needs_input(ev.notification_type.as_deref()) => Some(HookStatus::Waiting),
        "Stop" => Some(HookStatus::Idle),
        _ => None,
    };
    if let Some(s) = status {
        entry.status = Some((s, ev.at));
    }
    if let Some(p) = ev.pane_id {
        entry.pane_id = Some(p);
    }
}

/// Claude Code sends `Notification` for many notices (auth success, plugin and quota notices,
/// finished background agents); only these block on the user. `idle_prompt` is left out because
/// it follows a `Stop`, which already shows `done`, and would re-flag a pane the user has seen.
/// A missing type is an older Claude Code, whose notifications were all prompts.
fn needs_input(notification_type: Option<&str>) -> bool {
    matches!(
        notification_type,
        None | Some(
            "permission_prompt"
                | "worker_permission_prompt"
                | "elicitation_dialog"
                | "elicitation_url_dialog"
                | "agent_needs_input"
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    const TOKEN: &str = "abc123";

    fn post(token: Option<&str>, pane: Option<&str>, body: &str) -> (u16, Option<HookEvent>) {
        handle(TOKEN, &Method::Post, "/hook", token, pane, body.as_bytes(), Some(body.len()), 42)
    }

    fn event(name: &str, pane_id: Option<u32>, at: u64) -> HookEvent {
        HookEvent {
            session_id: "s1".into(),
            hook_event_name: name.into(),
            cwd: None,
            message: None,
            notification_type: None,
            pane_id,
            at,
        }
    }

    #[test]
    fn token_must_match() {
        let body = r#"{"session_id":"s1"}"#;
        assert_eq!(post(None, None, body).0, 403);
        assert_eq!(post(Some("abc124"), None, body).0, 403);
        assert_eq!(post(Some("abc12"), None, body).0, 403);
        assert_eq!(post(Some(TOKEN), None, body).0, 204);
    }

    #[test]
    fn oversized_bodies_are_rejected() {
        let small = br#"{"session_id":"s1"}"#;
        let by_header =
            handle(TOKEN, &Method::Post, "/hook", Some(TOKEN), None, small, Some(MAX_BODY + 1), 0);
        assert_eq!(by_header.0, 413);
        let big = vec![b' '; MAX_BODY + 1];
        let by_length = handle(TOKEN, &Method::Post, "/hook", Some(TOKEN), None, &big, None, 0);
        assert_eq!(by_length.0, 413);
    }

    #[test]
    fn bad_json_and_missing_session_id_are_400() {
        assert_eq!(post(Some(TOKEN), None, "not json").0, 400);
        assert_eq!(post(Some(TOKEN), None, r#"{"cwd":"/x"}"#).0, 400);
        assert_eq!(post(Some(TOKEN), None, r#"{"session_id":7}"#).0, 400);
    }

    #[test]
    fn other_paths_and_methods_are_404() {
        let body = br#"{"session_id":"s1"}"#;
        let get = handle(TOKEN, &Method::Get, "/hook", Some(TOKEN), None, body, None, 0);
        assert_eq!(get.0, 404);
        let other = handle(TOKEN, &Method::Post, "/other", Some(TOKEN), None, body, None, 0);
        assert_eq!(other.0, 404);
    }

    #[test]
    fn keeps_only_known_fields() {
        let body = r#"{"session_id":"s1","hook_event_name":"Notification","cwd":"C:\\x",
            "message":"needs you","notification_type":"permission_prompt","transcript_path":"C:\\t.jsonl","extra":1}"#;
        let (code, ev) = post(Some(TOKEN), Some("7"), body);
        assert_eq!(code, 204);
        let ev = ev.unwrap();
        assert_eq!(
            ev,
            HookEvent {
                session_id: "s1".into(),
                hook_event_name: "Notification".into(),
                cwd: Some("C:\\x".into()),
                message: Some("needs you".into()),
                notification_type: Some("permission_prompt".into()),
                pane_id: Some(7),
                at: 42,
            }
        );
        let json = serde_json::to_value(&ev).unwrap();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["sessionId", "hookEventName", "cwd", "message", "notificationType", "paneId", "at"]);
    }

    #[test]
    fn pane_header_must_parse() {
        let body = r#"{"session_id":"s1"}"#;
        assert_eq!(post(Some(TOKEN), Some("nope"), body).1.unwrap().pane_id, None);
        assert_eq!(post(Some(TOKEN), Some("-1"), body).1.unwrap().pane_id, None);
        assert_eq!(post(Some(TOKEN), None, body).1.unwrap().pane_id, None);
    }

    #[test]
    fn event_mapping() {
        let mut o = HashMap::new();
        apply(&mut o, &event("SessionStart", Some(3), 1));
        assert_eq!(o["s1"], HookOverlay { status: None, pane_id: Some(3), last_at: 1 });
        apply(&mut o, &event("UserPromptSubmit", None, 2));
        assert_eq!(
            o["s1"],
            HookOverlay { status: Some((HookStatus::Busy, 2)), pane_id: Some(3), last_at: 2 }
        );
        apply(&mut o, &event("Notification", Some(4), 3));
        assert_eq!(
            o["s1"],
            HookOverlay { status: Some((HookStatus::Waiting, 3)), pane_id: Some(4), last_at: 3 }
        );
        apply(&mut o, &event("PreToolUse", None, 4));
        assert_eq!(o["s1"].status, Some((HookStatus::Waiting, 3)));
        assert_eq!(o["s1"].last_at, 4);
        apply(&mut o, &event("Stop", None, 5));
        assert_eq!(o["s1"].status, Some((HookStatus::Idle, 5)));
        apply(&mut o, &event("SessionEnd", Some(9), 6));
        assert!(o.is_empty());
    }

    #[test]
    fn only_blocking_notifications_wait() {
        let notify = |kind: &str, at: u64| HookEvent {
            notification_type: Some(kind.into()),
            ..event("Notification", None, at)
        };
        let mut o = HashMap::new();
        apply(&mut o, &event("Stop", None, 1));
        for (i, kind) in ["idle_prompt", "auth_success", "plugin_notification", "agent_completed"].iter().enumerate() {
            apply(&mut o, &notify(kind, 2 + i as u64));
            assert_eq!(o["s1"].status, Some((HookStatus::Idle, 1)), "{kind}");
        }
        apply(&mut o, &notify("permission_prompt", 9));
        assert_eq!(o["s1"].status, Some((HookStatus::Waiting, 9)));
    }

    #[test]
    fn prune_keeps_live_and_recent_entries() {
        let entry = |last_at| HookOverlay { last_at, ..Default::default() };
        let mut o = HashMap::from([
            ("live".to_string(), entry(0)),
            ("recent".to_string(), entry(50_000)),
            ("stale".to_string(), entry(39_999)),
        ]);
        prune(&mut o, &HashSet::from(["live"]), 100_000);
        let mut kept: Vec<&str> = o.keys().map(String::as_str).collect();
        kept.sort();
        assert_eq!(kept, ["live", "recent"]);
    }

    fn raw_post(addr: std::net::SocketAddr, token: &str) -> String {
        let body = r#"{"session_id":"s1","hook_event_name":"Stop"}"#;
        let mut stream = TcpStream::connect(addr).unwrap();
        write!(
            stream,
            "POST /hook HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Bashboard-Token: {token}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn serves_over_loopback() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || serve(&server, TOKEN, |ev| tx.send(ev).unwrap(), |_| false, |_| {}));

        assert!(raw_post(addr, TOKEN).starts_with("HTTP/1.1 204"));
        assert_eq!(rx.recv().unwrap().hook_event_name, "Stop");
        assert!(raw_post(addr, "wrong!").starts_with("HTTP/1.1 403"));
        assert!(rx.try_recv().is_err());
    }

    fn cli_post(
        token: Option<&str>,
        pane: Option<&str>,
        body: &[u8],
        len: Option<usize>,
    ) -> (u16, Option<String>, Option<cli::CliCommand>) {
        handle_cli(TOKEN, &Method::Post, token, pane, body, len, &|id| id == 5)
    }

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-hooks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        dir
    }

    fn cli_body(command: &str, dir: &std::path::Path) -> String {
        serde_json::json!({ "command": command, "args": [], "cwd": dir.to_str().unwrap() }).to_string()
    }

    #[test]
    fn cli_bad_token_is_403() {
        let body = br#"{}"#;
        assert_eq!(cli_post(None, Some("5"), body, None).0, 403);
        assert_eq!(cli_post(Some("nope"), Some("5"), body, None).0, 403);
    }

    #[test]
    fn cli_needs_a_live_pane() {
        let body = br#"{}"#;
        assert_eq!(cli_post(Some(TOKEN), None, body, None).0, 404);
        assert_eq!(cli_post(Some(TOKEN), Some("x"), body, None).0, 404);
        assert_eq!(cli_post(Some(TOKEN), Some("6"), body, None).0, 404);
        let get = handle_cli(TOKEN, &Method::Get, Some(TOKEN), Some("5"), body, None, &|_| true);
        assert_eq!(get.0, 404);
    }

    #[test]
    fn cli_body_cap_is_one_mib() {
        let small = br#"{}"#;
        assert_eq!(cli_post(Some(TOKEN), Some("5"), small, Some(MAX_CLI_BODY + 1)).0, 413);
        let big = vec![b' '; MAX_CLI_BODY + 1];
        assert_eq!(cli_post(Some(TOKEN), Some("5"), &big, None).0, 413);
        // Past the /hook cap but under the /cli cap: reaches parse, which rejects the JSON.
        let mid = vec![b' '; MAX_BODY + 1];
        assert_eq!(cli_post(Some(TOKEN), Some("5"), &mid, Some(mid.len())).0, 400);
    }

    #[test]
    fn cli_unknown_command_is_400_with_json_error() {
        let dir = temp_repo("unknown");
        let body = cli_body("frob", &dir);
        let (code, err, cmd) = cli_post(Some(TOKEN), Some("5"), body.as_bytes(), None);
        assert_eq!(code, 400);
        assert!(cmd.is_none());
        let json: serde_json::Value = serde_json::from_str(&err.unwrap()).unwrap();
        assert_eq!(json["error"], "unknown command: frob");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cli_git_in_a_repo_is_204() {
        let dir = temp_repo("git");
        let body = cli_body("git", &dir);
        let (code, err, cmd) = cli_post(Some(TOKEN), Some(" 5 "), body.as_bytes(), Some(body.len()));
        assert_eq!((code, err), (204, None));
        let cmd = cmd.unwrap();
        assert_eq!(cmd.pty_id, 5);
        assert!(!cmd.collapsed);
        assert!(matches!(cmd.action, cli::CliAction::Git { .. }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hook_stays_capped_at_64_kib() {
        let big = vec![b' '; MAX_BODY + 1];
        let r = handle(TOKEN, &Method::Post, "/hook", Some(TOKEN), None, &big, Some(big.len()), 0);
        assert_eq!(r.0, 413);
    }

    #[test]
    fn serves_cli_over_loopback() {
        let server = Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || serve(&server, TOKEN, |_| {}, |id| id == 5, |cmd| tx.send(cmd).unwrap()));
        let dir = temp_repo("loopback");
        let send = |token: &str, pane: &str, body: &str| {
            let mut stream = TcpStream::connect(addr).unwrap();
            write!(
                stream,
                "POST /cli HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Bashboard-Token: {token}\r\n\
                 X-Bashboard-Pane: {pane}\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };

        let ok = send(TOKEN, "5", &cli_body("git", &dir));
        assert!(ok.starts_with("HTTP/1.1 204"), "{ok}");
        assert_eq!(rx.recv().unwrap().pty_id, 5);
        assert!(send("wrong!", "5", "{}").starts_with("HTTP/1.1 403"));
        assert!(send(TOKEN, "9", "{}").starts_with("HTTP/1.1 404"));
        let bad = send(TOKEN, "5", &cli_body("frob", &dir));
        assert!(bad.starts_with("HTTP/1.1 400"), "{bad}");
        assert!(bad.to_ascii_lowercase().contains("content-type: application/json"));
        assert!(bad.contains(r#"{"error":"#));
        assert!(rx.try_recv().is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
