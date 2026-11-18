//! Codex CLI rollouts: `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`. The first line is a
//! `session_meta` record whose `payload` holds the id, start time, cwd, and git branch; typed
//! prompts are `event_msg` records of type `user_message`. Thread names (`/rename` and Codex's
//! own titles) live apart from the rollouts, in `<home>/session_index.jsonl`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{clip_prompt, complete_lines, iso_ms, records, str_field, PastSession};
use crate::agents::AgentId;
use crate::transcript::codex::newest_reading;

/// Every `rollout-*.jsonl` under `<home>/sessions/YYYY/MM/DD`. Compressed `.jsonl.zst` rollouts
/// are skipped; reading them would need a decompressor for archives a user rarely resumes.
pub fn transcripts(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for year in subdirs(&home.join("sessions")) {
        for month in subdirs(&year) {
            for day in subdirs(&month) {
                let Ok(files) = std::fs::read_dir(&day) else {
                    continue;
                };
                for file in files.flatten() {
                    let name = file.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("rollout-")
                        && name.ends_with(".jsonl")
                        && file.file_type().is_ok_and(|t| t.is_file())
                    {
                        out.push(file.path());
                    }
                }
            }
        }
    }
    out
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect()
}

/// `session_index.jsonl` as a map from session id to thread name. Codex appends a line per
/// rename, so the last line for an id wins; a line with an empty name clears nothing.
pub fn parse_session_index(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if let (Some(id), Some(name)) = (str_field(&v, "id"), str_field(&v, "thread_name")) {
            out.insert(id.to_string(), name.to_string());
        }
    }
    out
}

/// A session from the head and tail of a rollout (see `super::complete_lines`), titled from
/// `names` (`parse_session_index`) when it has an entry. `None` without a `session_meta` id or a
/// user message.
pub fn read(
    head: &str,
    tail: &str,
    mtime_ms: u64,
    names: &HashMap<String, String>,
) -> Option<PastSession> {
    let mut id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut started: Option<u64> = None;
    let mut updated: Option<u64> = None;
    let (mut first, mut last) = (None, None);

    for v in records(head, tail) {
        if let Some(t) = str_field(&v, "timestamp").and_then(iso_ms) {
            started = Some(started.map_or(t, |s| s.min(t)));
            updated = Some(updated.map_or(t, |u| u.max(t)));
        }
        let payload = &v["payload"];
        match v["type"].as_str() {
            Some("session_meta") if id.is_none() => {
                id = str_field(payload, "id").map(str::to_string);
                cwd = str_field(payload, "cwd").map(str::to_string);
                branch = payload
                    .get("git")
                    .and_then(|g| str_field(g, "branch"))
                    .map(str::to_string);
                if let Some(t) = str_field(payload, "timestamp").and_then(iso_ms) {
                    started = Some(started.map_or(t, |s| s.min(t)));
                }
            }
            Some("event_msg") if payload["type"] == "user_message" => {
                if let Some(text) = payload["message"].as_str().and_then(clip_prompt) {
                    first = first.or_else(|| Some(text.clone()));
                    last = Some(text);
                }
            }
            _ => {}
        }
    }
    let id = id?;
    if first.is_none() && last.is_none() {
        return None;
    }
    let title = names
        .get(&id)
        .cloned()
        .or_else(|| first.clone())
        .or_else(|| last.clone())
        .unwrap_or_else(|| id.clone());
    let model = newest_reading(complete_lines(head, tail)).model;
    let updated_at = updated.unwrap_or(mtime_ms);
    Some(PastSession {
        agent: AgentId::Codex,
        session_id: id,
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

    const ID: &str = "019a1b2c-0000-7000-8000-abcdefabcdef";

    fn meta() -> String {
        format!(
            r#"{{"timestamp":"2026-11-17T10:00:00.500Z","type":"session_meta","payload":{{"id":"{ID}","timestamp":"2026-11-17T10:00:00Z","cwd":"/home/u/repo","originator":"codex_cli_rs","git":{{"commit_hash":"abc","branch":"main"}}}}}}"#
        )
    }

    fn prompt(text: &str, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"user_message","message":"{text}","kind":"plain"}}}}"#
        )
    }

    const TURN: &str = r#"{"timestamp":"2026-11-17T10:00:02Z","type":"turn_context","payload":{"model":"gpt-5.5","cwd":"/x"}}"#;

    fn whole(lines: &[String]) -> String {
        lines.join("\n") + "\n"
    }

    #[test]
    fn reads_a_small_rollout() {
        let text = whole(&[
            meta(),
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>"}]}}"#.into(),
            prompt("first ask", "2026-11-17T10:00:01Z"),
            TURN.into(),
            prompt("second ask", "2026-11-17T10:05:00Z"),
            "garbage".into(),
        ]);
        let s = read(&text, &text, 9, &HashMap::new()).unwrap();
        assert_eq!(s.agent, AgentId::Codex);
        assert_eq!(s.session_id, ID);
        assert_eq!(s.cwd, "/home/u/repo");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.title, "first ask");
        assert_eq!(s.first_prompt.as_deref(), Some("first ask"));
        assert_eq!(s.last_prompt.as_deref(), Some("second ask"));
        assert_eq!(s.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(s.started_at, iso_ms("2026-11-17T10:00:00Z").unwrap());
        assert_eq!(s.updated_at, iso_ms("2026-11-17T10:05:00Z").unwrap());
        assert_eq!(s.permission_mode, None);
    }

    #[test]
    fn thread_name_wins_and_the_last_index_line_for_an_id_wins() {
        let index = format!(
            "{{\"id\":\"{ID}\",\"thread_name\":\"Old\",\"updated_at\":\"t\"}}\nnot json\n{{\"id\":\"other\",\"thread_name\":\"X\"}}\n{{\"id\":\"{ID}\",\"thread_name\":\"Renamed\"}}\n{{\"id\":\"{ID}\",\"thread_name\":\"\"}}\n"
        );
        let names = parse_session_index(&index);
        assert_eq!(names.get(ID).map(String::as_str), Some("Renamed"));
        assert_eq!(names.len(), 2);
        let text = whole(&[meta(), prompt("ask", "2026-11-17T10:00:01Z")]);
        assert_eq!(read(&text, &text, 0, &names).unwrap().title, "Renamed");
    }

    #[test]
    fn no_prompt_or_no_meta_is_none() {
        let text = whole(&[meta(), TURN.into()]);
        assert_eq!(read(&text, &text, 0, &HashMap::new()), None);
        let text = whole(&[prompt("ask", "2026-11-17T10:00:01Z")]);
        assert_eq!(read(&text, &text, 0, &HashMap::new()), None);
    }

    #[test]
    fn head_and_tail_with_cut_lines() {
        let late = prompt("late ask", "2026-11-17T11:00:00Z");
        let head = format!(
            "{}\n{}\n{}",
            meta(),
            prompt("early", "2026-11-17T10:00:01Z"),
            &TURN[..30]
        );
        let tail = format!("{}\n{TURN}\n{late}\n", &late[15..]);
        let s = read(&head, &tail, 0, &HashMap::new()).unwrap();
        assert_eq!(s.first_prompt.as_deref(), Some("early"));
        assert_eq!(s.last_prompt.as_deref(), Some("late ask"));
        assert_eq!(s.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(s.updated_at, iso_ms("2026-11-17T11:00:00Z").unwrap());
    }

    #[test]
    fn transcripts_list_rollouts_and_skip_zst() {
        let home =
            std::env::temp_dir().join(format!("bashboard-history-codex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let day = home.join("sessions").join("2026").join("11").join("17");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-11-17T10-00-00-{ID}.jsonl")),
            "",
        )
        .unwrap();
        std::fs::write(day.join("rollout-2026-11-17T09-00-00-x.jsonl.zst"), "").unwrap();
        std::fs::write(day.join("other.jsonl"), "").unwrap();
        assert_eq!(
            transcripts(&home),
            vec![day.join(format!("rollout-2026-11-17T10-00-00-{ID}.jsonl"))]
        );
        assert!(transcripts(&home.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}
