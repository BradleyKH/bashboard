//! Copilot CLI session reading (docs/design/sessions.md section 3.3). `events.jsonl` carries the
//! model in `session.start` and `session.model_change`; token counts are ephemeral events Copilot
//! never writes to disk, so only the model is read. Every field is optional and an unparseable line
//! is skipped.
//!
//! With journal rotation on, Copilot archives the journal as `events.N.jsonl` and replaces
//! `events.jsonl` with a head that opens with `session.journal_link` and replays the session state
//! as ordinary events flagged `checkpoint: true`. Those replay events reuse the event types read
//! here, so they need no special case; `archives_newest_first` covers a head that names no model.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::AgentReading;

/// The model named by the newest `session.start`, `session.resume`, or `session.model_change`.
/// A resume names the model selected at resume time, which can differ from the start's.
pub fn newest_reading<'a>(lines: impl IntoIterator<Item = &'a str>) -> AgentReading {
    let mut model: Option<String> = None;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let key = match v["type"].as_str() {
            Some("session.model_change") => "newModel",
            Some("session.start" | "session.resume") => "selectedModel",
            _ => continue,
        };
        if let Some(m) = v["data"][key].as_str().filter(|m| !m.is_empty()) {
            model = Some(m.to_string());
        }
    }
    AgentReading {
        model,
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

/// The rotated journals beside `live` (`events.N.jsonl`), highest N first. N is compared as a
/// number, so `events.10.jsonl` is newer than `events.9.jsonl`.
pub fn archives_newest_first(live: &Path) -> Vec<PathBuf> {
    let Some(dir) = live.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name();
            let n = name
                .to_str()?
                .strip_prefix("events.")?
                .strip_suffix(".jsonl")?;
            if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some((n.parse().ok()?, e.path()))
        })
        .filter(|(_, p)| p.is_file())
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
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
    fn resume_model_wins_over_earlier_events() {
        let resume = r#"{"type":"session.resume","data":{"selectedModel":"gpt-5.2"}}"#;
        let r = newest_reading([START, CHANGE, resume]);
        assert_eq!(r.model.as_deref(), Some("gpt-5.2"));
        // A resume without a model leaves the earlier one.
        let bare = r#"{"type":"session.resume","data":{}}"#;
        assert_eq!(
            newest_reading([START, bare]).model.as_deref(),
            Some("claude-sonnet-4.5")
        );
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

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-copilot-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn model_of(live: &Path) -> Option<String> {
        super::super::read_session(crate::agents::AgentId::Copilot, live)
            .unwrap()
            .and_then(|r| r.model)
    }

    const LINK: &str = r#"{"type":"session.journal_link","data":{"previousFile":"events.2.jsonl","sessionId":"s","version":1},"checkpoint":true}"#;
    const USER: &str = r#"{"type":"user.message","data":{}}"#;

    #[test]
    fn checkpoint_events_with_the_model_read_like_any_other() {
        let cp = START.replace("}}", "}},\"checkpoint\":true").replace(",\"id\":\"1\"", "");
        assert_eq!(
            newest_reading([LINK, cp.as_str(), USER]).model.as_deref(),
            Some("claude-sonnet-4.5")
        );
    }

    #[test]
    fn archive_numbering_is_numeric_and_ignores_other_files() {
        let dir = scratch("numbering");
        for name in [
            "events.jsonl",
            "events.9.jsonl",
            "events.10.jsonl",
            "events.2.jsonl",
            "events..jsonl",
            "events.x.jsonl",
            "events.3.jsonl.bak",
            "workspace.yaml",
        ] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        let names: Vec<String> = archives_newest_first(&dir.join("events.jsonl"))
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["events.10.jsonl", "events.9.jsonl", "events.2.jsonl"]);
        assert!(archives_newest_first(&dir.join("missing").join("events.jsonl")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_comes_from_the_newest_archive_when_the_head_names_none() {
        let dir = scratch("archive");
        let live = dir.join("events.jsonl");
        std::fs::write(&live, format!("{LINK}
{USER}
")).unwrap();
        std::fs::write(dir.join("events.9.jsonl"), format!("{START}
")).unwrap();
        // 10 is newer than 9 even though it sorts before it as text.
        std::fs::write(dir.join("events.10.jsonl"), format!("{START}
{CHANGE}
")).unwrap();
        // The newest archive naming no model is passed over for the next one that does.
        std::fs::write(dir.join("events.11.jsonl"), format!("{USER}
")).unwrap();
        assert_eq!(model_of(&live).as_deref(), Some("gpt-5"));
        std::fs::remove_file(dir.join("events.10.jsonl")).unwrap();
        assert_eq!(model_of(&live).as_deref(), Some("claude-sonnet-4.5"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn live_model_wins_over_an_archive() {
        let dir = scratch("live");
        let live = dir.join("events.jsonl");
        let resume = r#"{"type":"session.resume","data":{"selectedModel":"gpt-5.2"},"checkpoint":true}"#;
        std::fs::write(&live, format!("{LINK}
{resume}
")).unwrap();
        std::fs::write(dir.join("events.1.jsonl"), format!("{START}
{CHANGE}
")).unwrap();
        assert_eq!(model_of(&live).as_deref(), Some("gpt-5.2"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_model_anywhere_is_none() {
        let dir = scratch("none");
        let live = dir.join("events.jsonl");
        std::fs::write(&live, format!("{USER}
")).unwrap();
        std::fs::write(dir.join("events.1.jsonl"), format!("{USER}
")).unwrap();
        assert_eq!(model_of(&live), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
