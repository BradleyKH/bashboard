//! Claude Code transcripts: `<home>/projects/<slug>/<id>.jsonl`, the id being the file stem.
//! `cwd`, `gitBranch`, and `timestamp` sit on `user` and `assistant` records; titles come from
//! `custom-title` (`/rename`), `ai-title`, and the older `summary` records.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{clip_prompt, iso_ms, records, str_field, PastSession};
use crate::agents::AgentId;

/// Every top-level `<home>/projects/*/*.jsonl`. Subagent transcripts live one folder deeper
/// (`<id>/subagents/agent-*.jsonl`) and older versions wrote them beside the session as
/// `agent-*.jsonl`; neither is a resumable session.
pub fn transcripts(home: &Path) -> Vec<PathBuf> {
    let Ok(projects) = std::fs::read_dir(home.join("projects")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|t| t.is_dir()) || project.file_name() == "subagents" {
            continue;
        }
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let name = file.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".jsonl")
                && !name.starts_with("agent-")
                && file.file_type().is_ok_and(|t| t.is_file())
            {
                out.push(file.path());
            }
        }
    }
    out
}

/// Text Claude Code wraps around slash commands, local command output, shell escapes, and
/// background task notices. These arrive as user records but are not something the user typed.
const WRAPPERS: [&str; 9] = [
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<bash-input>",
    "<bash-stdout>",
    "<task-notification>",
];

/// The typed text of a user record, or `None` for meta records, compaction summaries, command
/// wrappers, system reminders, and tool results.
fn prompt_text(v: &Value) -> Option<String> {
    let flag = |k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
    if flag("isMeta") || flag("isCompactSummary") {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.as_str(),
        Value::Array(parts) => {
            if parts.iter().any(|p| p["type"] == "tool_result") {
                return None;
            }
            parts
                .iter()
                .find(|p| p["type"] == "text")
                .and_then(|p| p["text"].as_str())?
        }
        _ => return None,
    };
    let trimmed = text.trim_start();
    if trimmed.starts_with("<system-reminder>") || WRAPPERS.iter().any(|w| trimmed.starts_with(w)) {
        return None;
    }
    clip_prompt(text)
}

/// A session from the head and tail of `<id>.jsonl` (see `super::records`). `None` for a
/// sidechain transcript or one with no user prompt.
pub fn read(id: &str, head: &str, tail: &str, mtime_ms: u64) -> Option<PastSession> {
    let mut cwd: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut started: Option<u64> = None;
    let mut updated: Option<u64> = None;
    let (mut custom, mut ai, mut summary) = (None, None, None);
    let (mut first, mut last_typed, mut last_record) = (None, None, None);
    let mut permission: Option<String> = None;
    let mut model: Option<String> = None;
    let (mut users, mut sidechain_users) = (0usize, 0usize);

    for v in records(head, tail) {
        let kind = v["type"].as_str().unwrap_or_default();
        let owned = |key: &str| str_field(&v, key).map(str::to_string);
        match kind {
            "custom-title" => custom = owned("customTitle").or(custom),
            "ai-title" => ai = owned("aiTitle").or(ai),
            "summary" => summary = owned("summary").or(summary),
            "last-prompt" => {
                last_record = str_field(&v, "lastPrompt")
                    .and_then(clip_prompt)
                    .or(last_record)
            }
            "permission-mode" => permission = owned("permissionMode").or(permission),
            "user" | "assistant" => {
                // The first cwd is where the session started, which is where a resume must run.
                if cwd.is_none() {
                    cwd = owned("cwd");
                }
                branch = owned("gitBranch").or(branch);
                if let Some(t) = str_field(&v, "timestamp").and_then(iso_ms) {
                    started = Some(started.map_or(t, |s| s.min(t)));
                    updated = Some(updated.map_or(t, |u| u.max(t)));
                }
                if kind == "user" {
                    users += 1;
                    if v["isSidechain"] == true {
                        sidechain_users += 1;
                    }
                    if let Some(text) = prompt_text(&v) {
                        first = first.or_else(|| Some(text.clone()));
                        last_typed = Some(text);
                    }
                } else if let Some(m) = v["message"]["model"]
                    .as_str()
                    .filter(|m| !m.is_empty() && *m != "<synthetic>")
                {
                    model = Some(m.to_string());
                }
            }
            _ => {}
        }
    }
    if users > 0 && users == sidechain_users {
        return None;
    }
    let last_prompt = last_record.or(last_typed);
    if first.is_none() && last_prompt.is_none() {
        return None;
    }
    let title = custom
        .or(ai)
        .or(summary)
        .or_else(|| first.clone())
        .or_else(|| last_prompt.clone())
        .unwrap_or_else(|| id.to_string());
    let updated_at = updated.unwrap_or(mtime_ms);
    Some(PastSession {
        agent: AgentId::Claude,
        session_id: id.to_string(),
        cwd: cwd.unwrap_or_default(),
        cwd_exists: false,
        repo_root: None,
        branch,
        title,
        first_prompt: first,
        last_prompt,
        started_at: started.unwrap_or(updated_at),
        updated_at,
        permission_mode: permission,
        model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str, ts: &str) -> String {
        serde_json::json!({
            "type": "user", "isSidechain": false, "cwd": "C:\\repo", "gitBranch": "main",
            "sessionId": "s1", "timestamp": ts, "message": {"role": "user", "content": text}
        })
        .to_string()
    }

    fn assistant(model: &str, ts: &str, branch: &str) -> String {
        serde_json::json!({
            "type": "assistant", "cwd": "C:\\repo\\sub", "gitBranch": branch, "timestamp": ts,
            "message": {"model": model, "content": [{"type": "text", "text": "ok"}]}
        })
        .to_string()
    }

    fn whole(lines: &[String]) -> String {
        lines.join("\n") + "\n"
    }

    fn read_whole(lines: &[String]) -> Option<PastSession> {
        let text = whole(lines);
        read("abc", &text, &text, 42)
    }

    #[test]
    fn reads_fields_from_a_small_transcript() {
        let s = read_whole(&[
            r#"{"type":"permission-mode","permissionMode":"default","sessionId":"s1"}"#.into(),
            user("  fix the\nbug ", "2026-11-17T10:00:00Z"),
            assistant("claude-opus-4-1", "2026-11-17T10:00:05Z", "main"),
            assistant("<synthetic>", "2026-11-17T10:00:06Z", "feature"),
            r#"{"type":"permission-mode","permissionMode":"plan","sessionId":"s1"}"#.into(),
            "not json".into(),
        ])
        .unwrap();
        assert_eq!(s.agent, AgentId::Claude);
        assert_eq!(s.session_id, "abc");
        assert_eq!(s.cwd, "C:\\repo");
        assert_eq!(s.branch.as_deref(), Some("feature"));
        assert_eq!(s.title, "fix the bug");
        assert_eq!(s.first_prompt.as_deref(), Some("fix the bug"));
        assert_eq!(s.last_prompt.as_deref(), Some("fix the bug"));
        assert_eq!(s.permission_mode.as_deref(), Some("plan"));
        assert_eq!(s.model.as_deref(), Some("claude-opus-4-1"));
        assert_eq!(s.started_at, iso_ms("2026-11-17T10:00:00Z").unwrap());
        assert_eq!(s.updated_at, iso_ms("2026-11-17T10:00:06Z").unwrap());
        assert!(!s.cwd_exists);
        assert_eq!(s.repo_root, None);
    }

    #[test]
    fn title_priority() {
        let base = vec![user("first prompt", "2026-11-17T10:00:00Z")];
        let with = |extra: &[&str]| {
            let mut lines = base.clone();
            lines.extend(extra.iter().map(|s| s.to_string()));
            read_whole(&lines).unwrap().title
        };
        let summary = r#"{"type":"summary","summary":"Old summary","leafUuid":"x"}"#;
        let ai1 = r#"{"type":"ai-title","aiTitle":"AI one","sessionId":"s1"}"#;
        let ai2 = r#"{"type":"ai-title","aiTitle":"AI two","sessionId":"s1"}"#;
        let custom = r#"{"type":"custom-title","customTitle":"Mine","sessionId":"s1"}"#;
        let blank = r#"{"type":"custom-title","customTitle":"  ","sessionId":"s1"}"#;
        assert_eq!(with(&[]), "first prompt");
        assert_eq!(with(&[summary]), "Old summary");
        assert_eq!(with(&[summary, ai1, ai2]), "AI two");
        assert_eq!(with(&[custom, ai1, summary]), "Mine");
        assert_eq!(with(&[custom, blank]), "Mine");
    }

    #[test]
    fn skips_meta_wrappers_and_tool_results_for_the_first_prompt() {
        let meta = r#"{"type":"user","isMeta":true,"message":{"content":"meta text"}}"#;
        let tool =
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}"#;
        let parts = r#"{"type":"user","message":{"content":[{"type":"image"},{"type":"text","text":"real ask"}]}}"#;
        let s = read_whole(&[
            meta.into(),
            user(
                "<command-name>/clear</command-name>",
                "2026-11-17T10:00:00Z",
            ),
            user(
                "<local-command-stdout></local-command-stdout>",
                "2026-11-17T10:00:00Z",
            ),
            user(
                "<system-reminder>x</system-reminder>",
                "2026-11-17T10:00:00Z",
            ),
            tool.into(),
            parts.into(),
            user("second ask", "2026-11-17T10:01:00Z"),
            tool.into(),
        ])
        .unwrap();
        assert_eq!(s.first_prompt.as_deref(), Some("real ask"));
        assert_eq!(s.last_prompt.as_deref(), Some("second ask"));
    }

    #[test]
    fn last_prompt_record_wins_over_the_last_typed_text() {
        let s = read_whole(&[
            user("one", "2026-11-17T10:00:00Z"),
            r#"{"type":"last-prompt","lastPrompt":"queued two","sessionId":"s1"}"#.into(),
            user("three", "2026-11-17T10:00:01Z"),
        ])
        .unwrap();
        assert_eq!(s.last_prompt.as_deref(), Some("queued two"));
    }

    #[test]
    fn no_prompt_is_none() {
        assert_eq!(
            read_whole(&[assistant("m", "2026-11-17T10:00:00Z", "main")]),
            None
        );
        assert_eq!(read("abc", "", "", 1), None);
    }

    #[test]
    fn sidechain_transcripts_are_none() {
        let side = user("sub task", "2026-11-17T10:00:00Z")
            .replace(r#""isSidechain":false"#, r#""isSidechain":true"#);
        assert_eq!(read_whole(&[side.clone(), side]), None);
    }

    #[test]
    fn head_and_tail_with_cut_lines() {
        let p1 = user("first", "2026-11-17T10:00:00Z");
        let late = assistant("claude-x", "2026-11-17T12:00:00Z", "dev");
        let title = r#"{"type":"ai-title","aiTitle":"Late title","sessionId":"s1"}"#;
        // The head ends partway through a record and the tail starts partway through another.
        let head = format!("{p1}\n{}", &late[..20]);
        let tail = format!("{}\n{late}\n{title}\n", &p1[10..]);
        let s = read("abc", &head, &tail, 5).unwrap();
        assert_eq!(s.first_prompt.as_deref(), Some("first"));
        assert_eq!(s.title, "Late title");
        assert_eq!(s.branch.as_deref(), Some("dev"));
        assert_eq!(s.model.as_deref(), Some("claude-x"));
        assert_eq!(s.started_at, iso_ms("2026-11-17T10:00:00Z").unwrap());
        assert_eq!(s.updated_at, iso_ms("2026-11-17T12:00:00Z").unwrap());
    }

    #[test]
    fn missing_times_fall_back_to_mtime() {
        let line = r#"{"type":"user","cwd":"/r","message":{"content":"hi"}}"#.to_string();
        let s = read_whole(&[line]).unwrap();
        assert_eq!((s.started_at, s.updated_at), (42, 42));
    }

    #[test]
    fn transcripts_skip_subagents() {
        let home =
            std::env::temp_dir().join(format!("bashboard-history-claude-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let project = home.join("projects").join("C--repo");
        std::fs::create_dir_all(project.join("abc").join("subagents")).unwrap();
        std::fs::write(project.join("abc.jsonl"), "").unwrap();
        std::fs::write(project.join("agent-1.jsonl"), "").unwrap();
        std::fs::write(project.join("notes.txt"), "").unwrap();
        std::fs::write(
            project.join("abc").join("subagents").join("agent-2.jsonl"),
            "",
        )
        .unwrap();
        assert_eq!(transcripts(&home), vec![project.join("abc.jsonl")]);
        assert!(transcripts(&home.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
