//! Codex CLI rollout reading (docs/design/sessions.md section 3.3). A rollout is JSONL with a
//! `turn_context` line per turn (carrying the model) and `event_msg` lines of type `token_count`.
//! The format is internal to Codex, so every field is optional and an unparseable line is skipped.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::AgentReading;

/// The newest model and context across `lines`, later lines winning. A `token_count` line whose
/// `info` is null (sent before the first model response) leaves the earlier reading in place.
pub fn newest_reading<'a>(lines: impl IntoIterator<Item = &'a str>) -> AgentReading {
    let mut out = AgentReading::default();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &v["payload"];
        match v["type"].as_str() {
            Some("turn_context") => {
                if let Some(m) = payload["model"].as_str().filter(|m| !m.is_empty()) {
                    out.model = Some(m.to_string());
                }
            }
            Some("event_msg") if payload["type"].as_str() == Some("token_count") => {
                let info = &payload["info"];
                // Codex's own "context left" uses last_token_usage.total_tokens
                // (TokenUsage::tokens_in_context_window), not input + output or the cumulative
                // total_token_usage.
                if let Some(tokens) = info["last_token_usage"]["total_tokens"].as_u64() {
                    out.context_tokens = Some(tokens);
                    out.context_window = info["model_context_window"].as_u64();
                }
            }
            _ => {}
        }
    }
    out
}

/// The newest `sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`. Day folders are searched newest first;
/// compressed `.jsonl.zst` rollouts are never a live session's file and are skipped.
pub fn find_rollout(sessions_dir: &Path, id: &str) -> Option<PathBuf> {
    if id.is_empty() {
        return None;
    }
    let suffix = format!("-{id}.jsonl");
    for year in subdirs_desc(sessions_dir) {
        for month in subdirs_desc(&year) {
            for day in subdirs_desc(&month) {
                let newest = fs::read_dir(&day)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter(|e| {
                        let name = e.file_name();
                        let name = name.to_string_lossy();
                        name.starts_with("rollout-") && name.ends_with(&suffix)
                    })
                    .map(|e| e.path())
                    .max();
                if newest.is_some() {
                    return newest;
                }
            }
        }
    }
    None
}

fn subdirs_desc(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    dirs.sort_by(|a, b| b.cmp(a));
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-codex-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const TURN: &str = r#"{"timestamp":"t","type":"turn_context","payload":{"model":"gpt-5.5","cwd":"/x","extra":1}}"#;
    const COUNT: &str = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":900,"cached_input_tokens":100,"output_tokens":50,"reasoning_output_tokens":0,"total_tokens":950},"last_token_usage":{"input_tokens":400,"cached_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":420},"model_context_window":272000,"future_field":true},"rate_limits":null}}"#;

    #[test]
    fn reads_model_and_context_from_newest_lines() {
        let newer = COUNT.replace("\"total_tokens\":420", "\"total_tokens\":777");
        let r = newest_reading([TURN, COUNT, "not json", newer.as_str()]);
        assert_eq!(r.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(r.context_tokens, Some(777));
        assert_eq!(r.context_window, Some(272000));
    }

    #[test]
    fn newest_turn_context_model_wins() {
        let later = TURN.replace("gpt-5.5", "gpt-5.6");
        let r = newest_reading([TURN, later.as_str()]);
        assert_eq!(r.model.as_deref(), Some("gpt-5.6"));
        assert_eq!(r.context_tokens, None);
    }

    #[test]
    fn null_or_missing_info_keeps_earlier_reading() {
        let null_info = r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}"#;
        let no_info = r#"{"type":"event_msg","payload":{"type":"token_count"}}"#;
        let r = newest_reading([COUNT, null_info, no_info]);
        assert_eq!(r.context_tokens, Some(420));
        assert_eq!(newest_reading([null_info]), AgentReading::default());
    }

    #[test]
    fn missing_window_is_none() {
        let l = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":5},"model_context_window":null}}}"#;
        let r = newest_reading([l]);
        assert_eq!(r.context_tokens, Some(5));
        assert_eq!(r.context_window, None);
    }

    #[test]
    fn find_rollout_picks_newest_and_skips_zst() {
        let root = temp_dir("find");
        let id = "019a1b2c-0000-7000-8000-abcdefabcdef";
        let old = root.join("2026/10/30");
        let new = root.join("2026/11/02");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join(format!("rollout-2026-10-30T01-00-00-{id}.jsonl")), "").unwrap();
        fs::write(new.join(format!("rollout-2026-11-02T01-00-00-{id}.jsonl.zst")), "").unwrap();
        fs::write(new.join("rollout-2026-11-02T01-00-00-other.jsonl"), "").unwrap();
        let found = find_rollout(&root, id).unwrap();
        assert!(found.ends_with(format!("rollout-2026-10-30T01-00-00-{id}.jsonl")));

        let newest = new.join(format!("rollout-2026-11-02T09-00-00-{id}.jsonl"));
        fs::write(&newest, "").unwrap();
        assert_eq!(find_rollout(&root, id), Some(newest));
        assert_eq!(find_rollout(&root, "nope"), None);
        assert_eq!(find_rollout(&root.join("missing"), id), None);
        let _ = fs::remove_dir_all(&root);
    }
}
