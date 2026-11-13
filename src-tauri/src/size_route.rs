//! `POST /size` on the loopback receiver (docs/design/git.md section 3.25): the branch size of
//! the worktree a folder is in, with the configured threshold, for `bb pr size`. Like `/ci`, each
//! request runs on its own thread (see `hooks::init`), since the diff may take a moment on a
//! large repo. Answers are JSON: 200 with `{ size, threshold }`, 400 for a bad request or a
//! folder outside a git repo, and 500 when git fails.

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::files::{find_repo, normalize};
use crate::git::Git;
use crate::git_branch_size::{BranchSize, branch_size};
use crate::git_worktrees::configured_for;
use crate::settings::SettingsState;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SizeRequest {
    pub cwd: String,
}

pub fn parse(body: &[u8]) -> Result<SizeRequest, String> {
    let req: SizeRequest =
        serde_json::from_slice(body).map_err(|e| format!("invalid request body: {e}"))?;
    let cwd = normalize(&req.cwd)?;
    if !cwd.is_dir() {
        return Err(format!("working directory does not exist: {}", req.cwd));
    }
    Ok(req)
}

fn error(code: u16, message: impl Into<String>) -> (u16, Value) {
    (code, json!({ "error": message.into() }))
}

fn reply(size: &BranchSize, threshold: u32) -> Value {
    json!({ "size": size, "threshold": threshold })
}

/// Measures the branch of one `/size` request's folder and answers with a status and a JSON body.
pub fn handle(app: &AppHandle, body: &[u8]) -> (u16, Value) {
    let req = match parse(body) {
        Ok(r) => r,
        Err(msg) => return error(400, msg),
    };
    let repo = match find_repo(&req.cwd) {
        Ok(r) if r.is_git => r,
        Ok(_) => return error(400, "not a git repository"),
        Err(msg) => return error(400, msg),
    };
    let settings = app.state::<SettingsState>();
    let threshold = settings.current().git.branch_size_threshold;
    let git = match Git::open(&settings, &repo.root) {
        Ok(g) => g,
        Err(msg) => return error(400, msg),
    };
    let size =
        configured_for(app, &git).and_then(|configured| branch_size(&git, configured.as_deref()));
    match size {
        Ok(size) => (200, reply(&size, threshold)),
        Err(msg) => error(500, msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_folder() {
        let dir = std::env::temp_dir();
        let body = json!({ "cwd": dir.to_string_lossy() }).to_string();
        assert_eq!(parse(body.as_bytes()).unwrap().cwd, dir.to_string_lossy());
    }

    #[test]
    fn rejects_bad_requests() {
        assert!(
            parse(b"not json")
                .unwrap_err()
                .starts_with("invalid request body")
        );
        assert!(parse(b"{}").is_err());
        let extra = json!({ "cwd": std::env::temp_dir().to_string_lossy(), "op": "x" });
        assert!(parse(extra.to_string().as_bytes()).is_err());
        assert!(
            parse(br#"{"cwd":"relative/dir"}"#)
                .unwrap_err()
                .contains("not an absolute path")
        );
        let gone = std::env::temp_dir().join("bashboard-size-route-missing-dir");
        let body = json!({ "cwd": gone.to_string_lossy() }).to_string();
        assert!(
            parse(body.as_bytes())
                .unwrap_err()
                .starts_with("working directory does not exist")
        );
    }

    #[test]
    fn answers_size_and_threshold() {
        let size = BranchSize {
            worktree: "C:\\r".into(),
            branch: Some("feature".into()),
            comparison: Some("origin/main".into()),
            lines: 512,
            added: 400,
            removed: 112,
            files: 14,
            excluded_lines: 210,
            excluded_files: 6,
        };
        assert_eq!(
            reply(&size, 400),
            json!({
                "size": {
                    "worktree": "C:\\r",
                    "branch": "feature",
                    "comparison": "origin/main",
                    "lines": 512,
                    "added": 400,
                    "removed": 112,
                    "files": 14,
                    "excludedLines": 210,
                    "excludedFiles": 6,
                },
                "threshold": 400,
            })
        );
        let none = BranchSize {
            worktree: "/r".into(),
            ..BranchSize::default()
        };
        let v = reply(&none, 0);
        assert!(v["size"]["comparison"].is_null());
        assert_eq!(v["threshold"], 0);
    }

    #[test]
    fn errors_are_json() {
        assert_eq!(
            error(400, "not a git repository"),
            (400, json!({ "error": "not a git repository" }))
        );
    }
}
