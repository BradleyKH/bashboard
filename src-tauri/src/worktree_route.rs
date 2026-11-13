//! `POST /worktree` on the loopback receiver (docs/design/git.md section 3.27), for
//! `bb worktree new`. Like `/size`, each request runs on its own thread (see `hooks::init`),
//! since it fetches and checks out. `dryRun` answers 200 `{ plan }`; otherwise a created
//! worktree answers 200 `{ created }` and emits `worktree://created` so the front end opens a
//! pane in it beside the calling one. A bad request or a failed check is a 400, and a git
//! failure while creating is a 500, each with `{ error }`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::agents::AgentId;
use crate::files::normalize;
use crate::git::Git;
use crate::git_worktrees::configured_for;
use crate::settings::SettingsState;
use crate::worktree_new::{WorktreeCreated, create, plan, repo_root};
use crate::worktree_trust::store_path;

pub const EVENT: &str = "worktree://created";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeRequest {
    pub cwd: String,
    pub branch: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

/// `ptyId` is the calling pane's `BASHBOARD_PANE_ID`, which the new pane opens beside.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreatedEvent {
    pub pty_id: u32,
    pub created: WorktreeCreated,
    pub agent: Option<String>,
    pub prompt: Option<String>,
}

pub fn parse(body: &[u8]) -> Result<WorktreeRequest, String> {
    let mut req: WorktreeRequest =
        serde_json::from_slice(body).map_err(|e| format!("invalid request body: {e}"))?;
    let cwd = normalize(&req.cwd)?;
    if !cwd.is_dir() {
        return Err(format!("working directory does not exist: {}", req.cwd));
    }
    if req.branch.trim().is_empty() {
        return Err("a branch name is required".to_string());
    }
    req.agent = req.agent.filter(|a| !a.trim().is_empty());
    if let Some(a) = &req.agent {
        if AgentId::parse(a).is_none() {
            return Err(format!(
                "unknown agent: {a} (expected claude, codex, or copilot)"
            ));
        }
    }
    req.prompt = req.prompt.filter(|p| !p.trim().is_empty());
    Ok(req)
}

fn error(code: u16, message: impl Into<String>) -> (u16, Value) {
    (code, json!({ "error": message.into() }))
}

/// Answers one `/worktree` request from the pane `pty_id` with a status and a JSON body.
pub fn handle(app: &AppHandle, pty_id: u32, body: &[u8]) -> (u16, Value) {
    let req = match parse(body) {
        Ok(r) => r,
        Err(msg) => return error(400, msg),
    };
    let root = match repo_root(&req.cwd) {
        Ok(r) => r,
        Err(msg) => return error(400, msg),
    };
    let settings = app.state::<SettingsState>();
    let git = match Git::open(&settings, &root) {
        Ok(g) => g,
        Err(msg) => return error(400, msg),
    };
    let configured = match configured_for(app, &git) {
        Ok(c) => c,
        Err(msg) => return error(500, msg),
    };
    let planned = match plan(
        &git,
        &req.branch,
        req.from.as_deref(),
        configured.as_deref(),
    ) {
        Ok(p) => p,
        Err(msg) => return error(400, msg),
    };
    if req.dry_run {
        return (200, json!({ "plan": planned }));
    }
    let trust = store_path(app);
    let created = match create(
        &git,
        &req.branch,
        req.from.as_deref(),
        configured.as_deref(),
        trust.as_deref(),
    ) {
        Ok(c) => c,
        Err(msg) => return error(500, msg),
    };
    let reply = json!({ "created": created });
    let _ = app.emit(EVENT, event(pty_id, created, req.agent, req.prompt));
    (200, reply)
}

fn event(
    pty_id: u32,
    created: WorktreeCreated,
    agent: Option<String>,
    prompt: Option<String>,
) -> WorktreeCreatedEvent {
    WorktreeCreatedEvent {
        pty_id,
        created,
        agent,
        prompt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree_new::{SetupState, WorktreePlan};

    fn body(extra: Value) -> Vec<u8> {
        let mut v = json!({ "cwd": std::env::temp_dir().to_string_lossy(), "branch": "b" });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v.to_string().into_bytes()
    }

    #[test]
    fn worktree_route_parses_a_request() {
        let req = parse(&body(json!({}))).unwrap();
        assert_eq!(req.branch, "b");
        assert!(!req.dry_run);
        assert_eq!((req.from, req.agent, req.prompt), (None, None, None));
        let req = parse(&body(json!({
            "from": "HEAD", "agent": "claude", "prompt": "fix it", "dryRun": true
        })))
        .unwrap();
        assert!(req.dry_run);
        assert_eq!(req.from.as_deref(), Some("HEAD"));
        assert_eq!(req.agent.as_deref(), Some("claude"));
        assert_eq!(req.prompt.as_deref(), Some("fix it"));
        // Blank optional fields read as absent.
        let req = parse(&body(json!({ "agent": "", "prompt": " " }))).unwrap();
        assert_eq!((req.agent, req.prompt), (None, None));
    }

    #[test]
    fn worktree_route_rejects_bad_requests() {
        assert!(
            parse(b"not json")
                .unwrap_err()
                .starts_with("invalid request body")
        );
        assert!(parse(b"{}").is_err());
        assert!(parse(&body(json!({ "op": "x" }))).is_err());
        assert!(
            parse(&body(json!({ "branch": " " })))
                .unwrap_err()
                .contains("branch name")
        );
        assert!(
            parse(&body(json!({ "agent": "vim" })))
                .unwrap_err()
                .contains("unknown agent")
        );
        assert!(
            parse(br#"{"cwd":"relative/dir","branch":"b"}"#)
                .unwrap_err()
                .contains("not an absolute path")
        );
        let gone = std::env::temp_dir().join("bashboard-worktree-route-missing-dir");
        let b = json!({ "cwd": gone.to_string_lossy(), "branch": "b" }).to_string();
        assert!(
            parse(b.as_bytes())
                .unwrap_err()
                .starts_with("working directory does not exist")
        );
    }

    #[test]
    fn worktree_route_event_shape() {
        let created = WorktreeCreated {
            plan: WorktreePlan {
                main_root: "/r".into(),
                branch: "b".into(),
                base_ref: "origin/main".into(),
                base_sha: "abc123".into(),
                short_sha: "abc".into(),
                path: "/r-b".into(),
                name: "r-b".into(),
                hint: true,
            },
            index: 1,
            copied: vec![],
            warnings: vec!["w".into()],
            setup: SetupState::Trusted,
        };
        let v = serde_json::to_value(event(7, created, Some("claude".into()), None)).unwrap();
        assert_eq!(v["ptyId"], 7);
        assert_eq!(v["agent"], "claude");
        assert!(v["prompt"].is_null());
        assert_eq!(v["created"]["setup"], "trusted");
        assert_eq!(v["created"]["plan"]["mainRoot"], "/r");
        assert_eq!(v["created"]["index"], 1);
    }

    #[test]
    fn worktree_route_errors_are_json() {
        assert_eq!(error(400, "nope"), (400, json!({ "error": "nope" })));
    }
}
