//! Copilot CLI sessions: `<home>/session-state/<id>/`, holding `workspace.yaml` (cwd, branch,
//! summary, and times) beside `events.jsonl` (typed prompts as `user.message` events, and the
//! model). Copilot writes the YAML itself as flat `key: value` lines, so it is read line by line
//! rather than through a YAML parser.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{clip_prompt, complete_lines, iso_ms, records, str_field, PastSession};
use crate::agents::AgentId;
use crate::transcript::copilot::newest_reading;

/// Each `<home>/session-state/<id>/events.jsonl` that exists. A session folder without one never
/// got a prompt.
pub fn transcripts(home: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(home.join("session-state"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path().join("events.jsonl"))
        .filter(|p| p.is_file())
        .collect()
}

/// `workspace.yaml` beside an `events.jsonl`.
pub fn workspace_path(events: &Path) -> PathBuf {
    events.with_file_name("workspace.yaml")
}

/// The top-level scalar `key: value` lines of `workspace.yaml`, with surrounding quotes removed.
/// Indented lines (nested maps, list items, block scalars) are skipped.
pub fn parse_workspace(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        if line.starts_with([' ', '\t', '#', '-']) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = unquote(value.trim());
        if !key.is_empty()
            && !value.is_empty()
            && !matches!(value.as_str(), "|" | ">" | "~" | "null")
        {
            out.insert(key.trim().to_string(), value);
        }
    }
    out
}

fn unquote(v: &str) -> String {
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        // Double-quoted YAML takes JSON's escapes for everything Copilot writes.
        return serde_json::from_str::<String>(v).unwrap_or_else(|_| v[1..v.len() - 1].to_string());
    }
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    v.to_string()
}

/// A session from its folder name `id`, the text of `workspace.yaml` if it could be read, and
/// the head and tail of `events.jsonl` (see `super::complete_lines`). `None` without a typed
/// prompt.
pub fn read(
    id: &str,
    workspace: Option<&str>,
    head: &str,
    tail: &str,
    mtime_ms: u64,
) -> Option<PastSession> {
    let yaml = workspace.map(parse_workspace).unwrap_or_default();
    let mut cwd = yaml.get("cwd").cloned();
    let mut branch = yaml.get("branch").cloned();
    let mut started = yaml.get("created_at").and_then(|t| iso_ms(t));
    let mut updated = yaml.get("updated_at").and_then(|t| iso_ms(t));
    let (mut first, mut last) = (None, None);

    for v in records(head, tail) {
        if let Some(t) = str_field(&v, "timestamp").and_then(iso_ms) {
            started = Some(started.map_or(t, |s| s.min(t)));
            updated = Some(updated.map_or(t, |u| u.max(t)));
        }
        let data = &v["data"];
        match v["type"].as_str() {
            Some("session.start") => {
                let context = data.get("context").unwrap_or(&Value::Null);
                if cwd.is_none() {
                    cwd = str_field(context, "cwd").map(str::to_string);
                }
                if branch.is_none() {
                    branch = str_field(context, "branch").map(str::to_string);
                }
            }
            Some("user.message") => {
                if let Some(text) = data["content"].as_str().and_then(clip_prompt) {
                    first = first.or_else(|| Some(text.clone()));
                    last = Some(text);
                }
            }
            _ => {}
        }
    }
    if first.is_none() && last.is_none() {
        return None;
    }
    let title = yaml
        .get("summary")
        .cloned()
        .or_else(|| first.clone())
        .or_else(|| last.clone())
        .unwrap_or_else(|| id.to_string());
    let model = newest_reading(complete_lines(head, tail)).model;
    let updated_at = updated.unwrap_or(mtime_ms);
    Some(PastSession {
        agent: AgentId::Copilot,
        session_id: id.to_string(),
        cwd: cwd.unwrap_or_default(),
        cwd_exists: false,
        repo_root: None,
        branch,
        title,
        first_prompt: first,
        last_prompt: last,
        started_at: started.unwrap_or(updated_at),
        updated_at,
        permission_mode: None,
        model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const YAML: &str = "id: s1\ncwd: C:\\Users\\u\\repo\ngit_root: C:\\Users\\u\\repo\nbranch: feature/x\nsummary: \"Fix the \\\"login\\\" bug\"\nsummary_count: 1\ncreated_at: 2026-11-17T10:00:00.000Z\nupdated_at: '2026-11-17T11:00:00.000Z'\nnested:\n  key: ignored\n";

    const START: &str = r#"{"type":"session.start","data":{"sessionId":"s1","selectedModel":"claude-sonnet-4.5","context":{"cwd":"/from/events","branch":"dev"}},"timestamp":"2026-11-17T10:00:01Z"}"#;

    fn prompt(text: &str, ts: &str) -> String {
        format!(
            r#"{{"type":"user.message","data":{{"content":"{text}","attachments":[]}},"timestamp":"{ts}"}}"#
        )
    }

    fn whole(lines: &[String]) -> String {
        lines.join("\n") + "\n"
    }

    #[test]
    fn workspace_lines_parse_leniently() {
        let w = parse_workspace(YAML);
        assert_eq!(w["cwd"], "C:\\Users\\u\\repo");
        assert_eq!(w["branch"], "feature/x");
        assert_eq!(w["summary"], "Fix the \"login\" bug");
        assert_eq!(w["updated_at"], "2026-11-17T11:00:00.000Z");
        assert!(!w.contains_key("nested"));
        assert!(!w.contains_key("key"));
        assert_eq!(parse_workspace("summary: 'it''s'\n")["summary"], "it's");
    }

    #[test]
    fn reads_workspace_and_events() {
        let text = whole(&[
            START.into(),
            prompt("first ask", "2026-11-17T10:00:02Z"),
            r#"{"type":"session.model_change","data":{"newModel":"gpt-5"},"timestamp":"2026-11-17T10:30:00Z"}"#.into(),
            prompt("second ask", "2026-11-17T10:31:00Z"),
            "garbage".into(),
        ]);
        let s = read("s1", Some(YAML), &text, &text, 3).unwrap();
        assert_eq!(s.agent, AgentId::Copilot);
        assert_eq!(s.session_id, "s1");
        assert_eq!(s.cwd, "C:\\Users\\u\\repo");
        assert_eq!(s.branch.as_deref(), Some("feature/x"));
        assert_eq!(s.title, "Fix the \"login\" bug");
        assert_eq!(s.first_prompt.as_deref(), Some("first ask"));
        assert_eq!(s.last_prompt.as_deref(), Some("second ask"));
        assert_eq!(s.model.as_deref(), Some("gpt-5"));
        assert_eq!(s.started_at, iso_ms("2026-11-17T10:00:00Z").unwrap());
        assert_eq!(s.updated_at, iso_ms("2026-11-17T11:00:00Z").unwrap());
    }

    #[test]
    fn without_workspace_events_supply_cwd_and_the_title_is_the_first_prompt() {
        let text = whole(&[START.into(), prompt("ask", "2026-11-17T10:00:02Z")]);
        let s = read("s1", None, &text, &text, 3).unwrap();
        assert_eq!(s.cwd, "/from/events");
        assert_eq!(s.branch.as_deref(), Some("dev"));
        assert_eq!(s.title, "ask");
        assert_eq!(s.model.as_deref(), Some("claude-sonnet-4.5"));
    }

    #[test]
    fn no_prompt_is_none() {
        let text = whole(&[START.into()]);
        assert_eq!(read("s1", Some(YAML), &text, &text, 0), None);
    }

    #[test]
    fn head_and_tail_with_cut_lines() {
        let late = prompt("late", "2026-11-17T12:00:00Z");
        let head = format!(
            "{START}\n{}\n{}",
            prompt("early", "2026-11-17T10:00:02Z"),
            &late[..12]
        );
        let tail = format!("{}\n{late}\n", &START[20..]);
        let s = read("s1", None, &head, &tail, 0).unwrap();
        assert_eq!(s.first_prompt.as_deref(), Some("early"));
        assert_eq!(s.last_prompt.as_deref(), Some("late"));
        assert_eq!(s.updated_at, iso_ms("2026-11-17T12:00:00Z").unwrap());
    }

    #[test]
    fn transcripts_need_an_events_file() {
        let home =
            std::env::temp_dir().join(format!("bashboard-history-copilot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let state = home.join("session-state");
        std::fs::create_dir_all(state.join("a")).unwrap();
        std::fs::create_dir_all(state.join("b")).unwrap();
        std::fs::write(state.join("a").join("events.jsonl"), "").unwrap();
        std::fs::write(state.join("b").join("workspace.yaml"), "").unwrap();
        let found = transcripts(&home);
        assert_eq!(found, vec![state.join("a").join("events.jsonl")]);
        assert_eq!(
            workspace_path(&found[0]),
            state.join("a").join("workspace.yaml")
        );
        assert!(transcripts(&home.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
