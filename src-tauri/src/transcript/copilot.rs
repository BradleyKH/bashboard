//! Copilot CLI session reading (docs/design.md section 3.3). `events.jsonl` carries the model in
//! `session.start` and `session.model_change`; token counts are ephemeral events Copilot never
//! writes to disk, so only the model is read. Every field is optional and an unparseable line is
//! skipped.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::AgentReading;

/// The newest `session.model_change` model, else `session.start`'s selected model.
pub fn newest_reading<'a>(lines: impl IntoIterator<Item = &'a str>) -> AgentReading {
    let mut changed: Option<String> = None;
    let mut started: Option<String> = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let (slot, key) = match v["type"].as_str() {
            Some("session.model_change") => (&mut changed, "newModel"),
            Some("session.start") => (&mut started, "selectedModel"),
            _ => continue,
        };
        if let Some(m) = v["data"][key].as_str().filter(|m| !m.is_empty()) {
            *slot = Some(m.to_string());
        }
    }
    AgentReading {
        model: changed.or(started),
        ..AgentReading::default()
    }
}

/// `<copilot_home>/session-state/<id>/events.jsonl`.
pub fn events_path(copilot_home: &Path, id: &str) -> PathBuf {
    copilot_home
        .join("session-state")
        .join(id)
        .join("events.jsonl")
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = r#"{"type":"session.start","data":{"sessionId":"s","selectedModel":"claude-sonnet-4.5","other":{}},"id":"1"}"#;
    const CHANGE: &str = r#"{"type":"session.model_change","data":{"previousModel":"a","newModel":"gpt-5"}}"#;

    #[test]
    fn start_model_when_no_change() {
        let r = newest_reading([START, "garbage", r#"{"type":"user.message","data":{}}"#]);
        assert_eq!(r.model.as_deref(), Some("claude-sonnet-4.5"));
        assert_eq!(r.context_tokens, None);
        assert_eq!(r.context_window, None);
    }

    #[test]
    fn newest_model_change_wins_over_start() {
        let later = CHANGE.replace("gpt-5", "gpt-5.1");
        let r = newest_reading([START, CHANGE, later.as_str()]);
        assert_eq!(r.model.as_deref(), Some("gpt-5.1"));
        // A tail that starts after session.start still reads the change.
        assert_eq!(newest_reading([CHANGE]).model.as_deref(), Some("gpt-5"));
    }

    #[test]
    fn empty_input_is_default() {
        assert_eq!(newest_reading([]), AgentReading::default());
    }

    #[test]
    fn events_path_layout() {
        let p = events_path(Path::new("home"), "abc");
        assert_eq!(p, Path::new("home").join("session-state").join("abc").join("events.jsonl"));
    }
}
