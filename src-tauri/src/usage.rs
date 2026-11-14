//! Agent usage limits (docs/design/sessions.md section 3.28): limit windows from Claude Code's
//! status line input (posted to the hook receiver's `/usage` by `bb statusline`) and from Codex
//! rollouts' `rate_limits`, kept per agent and label and emitted as `usage://changed`. Neither
//! input names an account, so the newest report wins.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agents::AgentId;
use crate::lock::LockExt;

/// One limit window. `resets_at` is in seconds since the epoch.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub agent: AgentId,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
}

#[derive(Default)]
pub struct Usage {
    windows: Mutex<Vec<UsageWindow>>,
}

/// Every known window, ordered by agent and then label.
#[tauri::command]
pub fn usage_snapshot(state: State<'_, Usage>) -> Vec<UsageWindow> {
    state.windows.lock_or_recover().clone()
}

/// Folds a report into the store and emits the whole snapshot on `usage://changed` when it
/// changed anything.
pub fn report(app: &AppHandle, windows: Vec<UsageWindow>) {
    let state = app.state::<Usage>();
    let snapshot = {
        let mut current = state.windows.lock_or_recover();
        if !merge(&mut current, windows) {
            return;
        }
        current.clone()
    };
    let _ = app.emit("usage://changed", snapshot);
}

/// Replaces each incoming window's (agent, label) entry. Windows a report leaves out are kept,
/// since both inputs omit a window until they have a number for it; the front end drops a
/// window once its reset time passes.
fn merge(current: &mut Vec<UsageWindow>, incoming: Vec<UsageWindow>) -> bool {
    let mut changed = false;
    for w in incoming {
        match current
            .iter_mut()
            .find(|c| c.agent == w.agent && c.label == w.label)
        {
            Some(c) if *c == w => {}
            Some(c) => {
                *c = w;
                changed = true;
            }
            None => {
                current.push(w);
                changed = true;
            }
        }
    }
    if changed {
        current.sort_by(|a, b| {
            let rank = |id: AgentId| AgentId::ALL.iter().position(|&x| x == id);
            rank(a.agent)
                .cmp(&rank(b.agent))
                .then_with(|| a.label.cmp(&b.label))
        });
    }
    changed
}

/// Claude Code's status line input: `rate_limits.five_hour` and `rate_limits.seven_day`, each
/// `used_percentage` and `resets_at`. They are absent until a response carried rate-limit
/// headers (subscription logins only), and an absent window yields nothing.
pub fn from_claude_status_line(agent: AgentId, json: &Value) -> Vec<UsageWindow> {
    let limits = &json["rate_limits"];
    [("five_hour", "5-hour"), ("seven_day", "weekly")]
        .into_iter()
        .filter_map(|(key, label)| {
            let w = &limits[key];
            Some(UsageWindow {
                agent,
                label: label.to_string(),
                used_percent: w["used_percentage"].as_f64()?,
                resets_at: w["resets_at"].as_i64(),
            })
        })
        .collect()
}

/// A Codex `RateLimitSnapshot` (`primary` and `secondary` of `used_percent`, `window_minutes`,
/// `resets_at`). `rate_limit_reached_type` does not name the window, so when it is set the
/// fullest window is reported at 100. Null (an API-key login) yields nothing.
pub fn from_codex_rate_limits(json: &Value) -> Vec<UsageWindow> {
    let mut out: Vec<UsageWindow> = [
        ("primary", &json["primary"]),
        ("secondary", &json["secondary"]),
    ]
    .into_iter()
    .filter_map(|(slot, w)| {
        let minutes = w["window_minutes"].as_i64();
        Some(UsageWindow {
            agent: AgentId::Codex,
            label: minutes.map_or_else(|| slot.to_string(), window_label),
            used_percent: w["used_percent"].as_f64()?,
            resets_at: w["resets_at"].as_i64(),
        })
    })
    .collect();
    let reached = json["rate_limit_reached_type"]
        .as_str()
        .is_some_and(|t| !t.is_empty());
    if reached {
        let fullest = out.iter_mut().reduce(|a, b| {
            if b.used_percent > a.used_percent {
                b
            } else {
                a
            }
        });
        if let Some(w) = fullest {
            w.used_percent = w.used_percent.max(100.0);
        }
    }
    out
}

fn window_label(minutes: i64) -> String {
    match minutes {
        10080 => "weekly".to_string(),
        m if m > 0 && m % 1440 == 0 => format!("{}-day", m / 1440),
        m if m > 0 && m % 60 == 0 => format!("{}-hour", m / 60),
        m => format!("{m}-minute"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn window(agent: AgentId, label: &str, used: f64, resets: Option<i64>) -> UsageWindow {
        UsageWindow {
            agent,
            label: label.into(),
            used_percent: used,
            resets_at: resets,
        }
    }

    #[test]
    fn claude_status_line_reads_both_windows() {
        let input = json!({
            "model": { "id": "claude-opus" },
            "rate_limits": {
                "five_hour": { "used_percentage": 84, "resets_at": 1999999999 },
                "seven_day": { "used_percentage": 12.5, "resets_at": 2000000000 }
            }
        });
        assert_eq!(
            from_claude_status_line(AgentId::Claude, &input),
            [
                window(AgentId::Claude, "5-hour", 84.0, Some(1999999999)),
                window(AgentId::Claude, "weekly", 12.5, Some(2000000000)),
            ]
        );
    }

    #[test]
    fn claude_absent_fields_yield_no_window() {
        assert!(from_claude_status_line(AgentId::Claude, &json!({})).is_empty());
        assert!(
            from_claude_status_line(AgentId::Claude, &json!({ "rate_limits": null })).is_empty()
        );
        let partial = json!({ "rate_limits": {
            "five_hour": { "used_percentage": 50 },
            "seven_day": { "resets_at": 5 }
        }});
        assert_eq!(
            from_claude_status_line(AgentId::Claude, &partial),
            [window(AgentId::Claude, "5-hour", 50.0, None)]
        );
    }

    #[test]
    fn codex_snapshot_labels_from_minutes() {
        let input = json!({
            "limit_id": "codex",
            "primary": { "used_percent": 40.0, "window_minutes": 300, "resets_at": 100 },
            "secondary": { "used_percent": 7.0, "window_minutes": 10080, "resets_at": 200 },
            "credits": null,
            "plan_type": "plus",
            "rate_limit_reached_type": null
        });
        assert_eq!(
            from_codex_rate_limits(&input),
            [
                window(AgentId::Codex, "5-hour", 40.0, Some(100)),
                window(AgentId::Codex, "weekly", 7.0, Some(200)),
            ]
        );
        assert_eq!(window_label(120), "2-hour");
        assert_eq!(window_label(2880), "2-day");
        assert_eq!(window_label(90), "90-minute");
    }

    #[test]
    fn codex_null_and_missing_fields() {
        assert!(from_codex_rate_limits(&Value::Null).is_empty());
        let input = json!({
            "primary": { "used_percent": 10.0, "window_minutes": 300, "resets_at": null },
            "secondary": null
        });
        assert_eq!(
            from_codex_rate_limits(&input),
            [window(AgentId::Codex, "5-hour", 10.0, None)]
        );
        let no_minutes = json!({ "primary": { "used_percent": 1.0 } });
        assert_eq!(from_codex_rate_limits(&no_minutes)[0].label, "primary");
    }

    #[test]
    fn codex_reached_type_reports_the_fullest_window_at_100() {
        let input = json!({
            "primary": { "used_percent": 60.0, "window_minutes": 300, "resets_at": 1 },
            "secondary": { "used_percent": 99.4, "window_minutes": 10080, "resets_at": 2 },
            "rate_limit_reached_type": "rate_limit_reached"
        });
        let out = from_codex_rate_limits(&input);
        assert_eq!(out[0].used_percent, 60.0);
        assert_eq!(out[1].used_percent, 100.0);
    }

    #[test]
    fn merge_replaces_by_agent_and_label_and_reports_change() {
        let mut store = Vec::new();
        assert!(!merge(&mut store, Vec::new()));
        assert!(merge(
            &mut store,
            vec![window(AgentId::Codex, "5-hour", 1.0, None)]
        ));
        assert!(merge(
            &mut store,
            vec![window(AgentId::Claude, "weekly", 2.0, None)]
        ));
        assert!(!merge(
            &mut store,
            vec![window(AgentId::Claude, "weekly", 2.0, None)]
        ));
        assert!(merge(
            &mut store,
            vec![window(AgentId::Claude, "weekly", 3.0, Some(9))]
        ));
        assert!(merge(
            &mut store,
            vec![window(AgentId::Claude, "5-hour", 4.0, None)]
        ));
        let keys: Vec<(AgentId, &str, f64)> = store
            .iter()
            .map(|w| (w.agent, w.label.as_str(), w.used_percent))
            .collect();
        assert_eq!(
            keys,
            [
                (AgentId::Claude, "5-hour", 4.0),
                (AgentId::Claude, "weekly", 3.0),
                (AgentId::Codex, "5-hour", 1.0)
            ]
        );
    }

    #[test]
    fn window_serializes_camel_case() {
        let json = serde_json::to_value(window(AgentId::Claude, "5-hour", 84.0, Some(7))).unwrap();
        assert_eq!(
            json,
            json!({ "agent": "claude", "label": "5-hour", "usedPercent": 84.0, "resetsAt": 7 })
        );
    }
}
