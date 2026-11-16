//! Stuck background agents (docs/design/sessions.md section 3.30): whether a subagent that a
//! session's last `Stop` left running has gone quiet for longer than `needsYou.stuckAgentMinutes`.
//!
//! Claude Code writes each subagent's transcript to `<session>/subagents/agent-<id>.jsonl` beside
//! the session's own transcript, appending on every message and tool result, so the file's
//! modified time is the agent's heartbeat. Beside it, `agent-<id>.meta.json` names the agent's
//! parent (`parentAgentId`) and gains `"finished": true` once it ends. An agent waiting on its
//! own background agents writes nothing until they report back, so an agent's activity is the
//! newest write in its tree of unfinished descendants, not its own file alone.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Deserialize;

use crate::hooks::BackgroundTask;

/// A background agent judged stuck: the session's waiting reason, and when it became stuck.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stuck {
    /// The task id, so a verdict from an earlier `Stop` is never applied to a later one.
    pub task_id: String,
    pub reason: String,
    /// Epoch ms: the agent's last activity plus the threshold.
    pub since: u64,
}

/// One subagent's metadata, as far as the tree walk needs it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentMeta {
    pub parent: Option<String>,
    pub finished: bool,
}

/// The session's subagent folder: its transcript path without `.jsonl`, plus `subagents`.
pub fn subagents_dir(transcript_path: &str) -> PathBuf {
    Path::new(transcript_path).with_extension("").join("subagents")
}

/// Reads the folder and judges `tasks`; `None` when nothing is stuck or the folder is missing.
pub fn check(transcript_path: &str, tasks: &[BackgroundTask], now: u64, threshold_ms: u64) -> Option<Stuck> {
    if threshold_ms == 0 || !tasks.iter().any(|t| t.kind == "subagent") {
        return None;
    }
    let dir = subagents_dir(transcript_path);
    let metas = read_metas(&dir);
    let modified = |id: &str| -> Option<u64> {
        let time = std::fs::metadata(dir.join(format!("agent-{id}.jsonl"))).ok()?.modified().ok()?;
        Some(time.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
    };
    judge(tasks, &metas, modified, now, threshold_ms)
}

fn read_metas(dir: &Path) -> HashMap<String, AgentMeta> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        parent_agent_id: Option<String>,
        #[serde(default)]
        finished: bool,
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return HashMap::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name.strip_prefix("agent-")?.strip_suffix(".meta.json")?.to_owned();
            let raw: Raw = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
            Some((id, AgentMeta { parent: raw.parent_agent_id, finished: raw.finished }))
        })
        .collect()
}

/// The stalest subagent task quiet for at least `threshold_ms`. A task whose transcript cannot
/// be read is never judged, since silence there proves nothing.
pub fn judge(
    tasks: &[BackgroundTask],
    metas: &HashMap<String, AgentMeta>,
    modified: impl Fn(&str) -> Option<u64>,
    now: u64,
    threshold_ms: u64,
) -> Option<Stuck> {
    tasks
        .iter()
        .filter(|t| t.kind == "subagent")
        .filter_map(|t| {
            let own = modified(&t.id)?;
            let active = unfinished_descendants(&t.id, metas).iter().filter_map(|id| modified(id)).fold(own, u64::max);
            (now.saturating_sub(active) >= threshold_ms).then_some((t, active))
        })
        .min_by_key(|(_, active)| *active)
        .map(|(t, active)| Stuck {
            task_id: t.id.clone(),
            reason: stuck_reason(&t.description),
            since: active + threshold_ms,
        })
}

/// The front end's Needs you row keys its phrase on "may be stuck", so keep that wording.
fn stuck_reason(description: &str) -> String {
    let description = description.trim();
    if description.is_empty() {
        "Background agent may be stuck".to_owned()
    } else {
        format!("Background agent may be stuck: {description}")
    }
}

fn unfinished_descendants(root: &str, metas: &HashMap<String, AgentMeta>) -> Vec<String> {
    let mut out = Vec::new();
    let mut frontier = vec![root.to_owned()];
    while let Some(parent) = frontier.pop() {
        for (id, meta) in metas {
            // The length cap guards against a parent cycle in a hand-edited or corrupt folder.
            if !meta.finished && meta.parent.as_deref() == Some(parent.as_str()) && !out.contains(id) && out.len() < 256 {
                out.push(id.clone());
                frontier.push(id.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    fn task(id: &str, kind: &str, description: &str) -> BackgroundTask {
        BackgroundTask { id: id.into(), kind: kind.into(), description: description.into() }
    }

    fn meta(parent: Option<&str>, finished: bool) -> AgentMeta {
        AgentMeta { parent: parent.map(str::to_owned), finished }
    }

    fn times(pairs: &[(&str, u64)]) -> impl Fn(&str) -> Option<u64> {
        let map: HashMap<String, u64> = pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect();
        move |id| map.get(id).copied()
    }

    #[test]
    fn quiet_agent_is_stuck_from_activity_plus_threshold() {
        let tasks = [task("a", "subagent", "Drift review item 7")];
        let now = 100 * MIN;
        assert_eq!(judge(&tasks, &HashMap::new(), times(&[("a", now - 14 * MIN)]), now, 15 * MIN), None);
        assert_eq!(
            judge(&tasks, &HashMap::new(), times(&[("a", now - 20 * MIN)]), now, 15 * MIN),
            Some(Stuck {
                task_id: "a".into(),
                reason: "Background agent may be stuck: Drift review item 7".into(),
                since: now - 5 * MIN,
            })
        );
    }

    #[test]
    fn unfinished_descendants_count_as_activity() {
        let tasks = [task("a", "subagent", "")];
        let now = 100 * MIN;
        let metas = HashMap::from([
            ("b".to_owned(), meta(Some("a"), false)),
            ("c".to_owned(), meta(Some("b"), false)),
            ("d".to_owned(), meta(Some("a"), true)),
        ]);
        let quiet = now - 60 * MIN;
        // A grandchild still writing keeps the whole tree alive.
        assert_eq!(judge(&tasks, &metas, times(&[("a", quiet), ("b", quiet), ("c", now - MIN)]), now, 15 * MIN), None);
        // A finished child's recent write does not.
        let stuck = judge(&tasks, &metas, times(&[("a", quiet), ("b", quiet), ("c", quiet), ("d", now)]), now, 15 * MIN);
        assert_eq!(stuck.map(|s| s.reason), Some("Background agent may be stuck".into()));
    }

    #[test]
    fn stalest_task_wins_and_unreadable_or_non_subagent_tasks_are_skipped() {
        let tasks = [task("w", "workflow", "wf"), task("x", "subagent", "x"), task("a", "subagent", "A"), task("b", "subagent", "B")];
        let now = 100 * MIN;
        let stuck = judge(&tasks, &HashMap::new(), times(&[("w", 0), ("a", now - 30 * MIN), ("b", now - 50 * MIN)]), now, 15 * MIN);
        assert_eq!(stuck.unwrap().task_id, "b");
    }

    #[test]
    fn parent_cycles_terminate() {
        let metas = HashMap::from([("b".to_owned(), meta(Some("c"), false)), ("c".to_owned(), meta(Some("b"), false))]);
        let mut found = unfinished_descendants("b", &metas);
        found.sort();
        assert_eq!(found, ["b", "c"]);
    }

    #[test]
    fn subagent_folder_sits_beside_the_transcript() {
        let dir = subagents_dir(r"C:\Users\u\.claude\projects\p\36136032-55c2.jsonl");
        assert_eq!(dir, Path::new(r"C:\Users\u\.claude\projects\p\36136032-55c2").join("subagents"));
    }

    #[test]
    fn check_reads_the_folder() {
        let root = std::env::temp_dir().join(format!("bb-stuck-{}", std::process::id()));
        let dir = root.join("s1").join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent-a.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("agent-a.meta.json"), r#"{"agentType":"general-purpose"}"#).unwrap();
        let transcript = root.join("s1.jsonl").to_string_lossy().into_owned();
        let tasks = [task("a", "subagent", "probe")];
        let now = crate::hooks::now_ms();
        assert_eq!(check(&transcript, &tasks, now, 15 * MIN), None);
        assert_eq!(check(&transcript, &tasks, now + 16 * MIN, 15 * MIN).map(|s| s.task_id), Some("a".into()));
        assert_eq!(check(&transcript, &tasks, now + 16 * MIN, 0), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
