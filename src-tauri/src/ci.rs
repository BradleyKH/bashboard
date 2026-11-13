//! `POST /ci` on the loopback receiver (docs/design/ship.md section 3.23): what Ship knows
//! about a repo's CI, for `bb ci`. Each request runs on its own thread (see `hooks::init`), so
//! the forge calls here may block. Answers are JSON: 200 with the result, 400 for a bad
//! request, 403 when `ship.cliWrites` refuses a write, 404 when there is no run to act on,
//! and 502 for a forge failure.

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::files::{find_repo, normalize};
use crate::forge::{
    self, diagnostic,
    types::{Capabilities, ForgeError, PullRequest, Run, RunStatus},
};
use crate::git::Git;
use crate::settings::SettingsState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Status,
    Failed,
    Log,
    Rerun,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CiRequest {
    pub op: Op,
    pub cwd: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub failed_only: bool,
}

pub fn parse(body: &[u8]) -> Result<CiRequest, String> {
    let mut req: CiRequest =
        serde_json::from_slice(body).map_err(|e| format!("invalid request body: {e}"))?;
    let cwd = normalize(&req.cwd)?;
    if !cwd.is_dir() {
        return Err(format!("working directory does not exist: {}", req.cwd));
    }
    let blank_to_none =
        |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    req.branch = blank_to_none(req.branch);
    req.run_id = blank_to_none(req.run_id);
    req.job_id = blank_to_none(req.job_id);
    if req.op == Op::Log && (req.run_id.is_none() || req.job_id.is_none()) {
        return Err("log needs runId and jobId".into());
    }
    if req.failed_only && req.op != Op::Rerun {
        return Err("failedOnly applies only to rerun".into());
    }
    Ok(req)
}

fn error(code: u16, message: impl Into<String>) -> (u16, Value) {
    (code, json!({ "error": message.into() }))
}

fn forge_error(e: ForgeError) -> (u16, Value) {
    (502, json!({ "error": e.message, "kind": e.kind }))
}

/// Runs one `/ci` request against the forge and answers with a status and a JSON body.
pub fn handle(app: &AppHandle, body: &[u8]) -> (u16, Value) {
    let req = match parse(body) {
        Ok(r) => r,
        Err(msg) => return error(400, msg),
    };
    let settings = app.state::<SettingsState>();
    if matches!(req.op, Op::Rerun | Op::Cancel) && !settings.current().ship.cli_writes {
        return error(403, write_refusal(req.op));
    }
    let repo = match find_repo(&req.cwd) {
        Ok(r) if r.is_git => r,
        Ok(_) => return error(400, "This folder isn't in a git repo."),
        Err(msg) => return error(400, msg),
    };
    let root = repo.root;
    let git = match Git::open(&settings, &root) {
        Ok(g) => g,
        Err(msg) => return error(400, msg),
    };
    let checked_out = git_value(&git, &["symbolic-ref", "-q", "--short", "HEAD"]);
    let Some(branch) = req.branch.clone().or_else(|| checked_out.clone()) else {
        return error(400, "HEAD is detached; pass a branch.");
    };
    // The local HEAD names the commit to watch only on the branch it belongs to.
    let head_sha = (checked_out.as_deref() == Some(branch.as_str()))
        .then(|| git_value(&git, &["rev-parse", "HEAD"]))
        .flatten();

    let result = match req.op {
        Op::Status => status(app, &root, &branch, head_sha.as_deref()),
        Op::Failed => failed(app, &root, &branch, req.run_id.as_deref()),
        Op::Log => log(
            app,
            &root,
            req.run_id.as_deref().unwrap_or_default(),
            req.job_id.as_deref().unwrap_or_default(),
        ),
        Op::Rerun | Op::Cancel => write(app, &root, &branch, &req),
    };
    match result {
        Ok(Reply::Ok(v)) => (200, v),
        Ok(Reply::Refused(code, msg)) => error(code, msg),
        Err(e) => forge_error(e),
    }
}

enum Reply {
    Ok(Value),
    Refused(u16, String),
}

fn git_value(git: &Git, args: &[&str]) -> Option<String> {
    let out = git.read(args).ok()?;
    Git::ok(out).ok().filter(|v| !v.is_empty())
}

fn write_refusal(op: Op) -> String {
    let verb = if op == Op::Rerun { "rerun" } else { "cancel" };
    format!(
        "bb ci {verb} is off: set \"ship.cliWrites\": true in Bashboard's settings to let bb \
         re-run and cancel pipelines."
    )
}

/// Runs and the branch's pull request are fetched side by side; an error from either stands,
/// so `bb ci wait` counts it as a failed read rather than as "no pull request".
fn status(
    app: &AppHandle,
    root: &str,
    branch: &str,
    head_sha: Option<&str>,
) -> Result<Reply, ForgeError> {
    let repo = forge::repo_of(app, root)?;
    let (runs, pulls) = std::thread::scope(|s| {
        let pulls = s.spawn(|| {
            forge::with_provider(app, root, |p, cx, r| p.pulls(cx, r, false, Some(branch)))
        });
        let runs = forge::with_provider(app, root, |p, cx, r| p.runs(cx, r, Some(branch)));
        let pulls = pulls
            .join()
            .unwrap_or_else(|_| Err(ForgeError::other("Listing pull requests failed.")));
        (runs, pulls)
    });
    let runs = head_runs(&on_branch(runs?, branch), head_sha);
    let pull = newest_pull(&pulls?.items, branch).cloned();
    Ok(Reply::Ok(json!({
        "repo": {
            "provider": repo.provider,
            "host": repo.host,
            "owner": repo.owner,
            "name": repo.name,
            "webUrl": repo.web_url,
        },
        "branch": branch,
        "headSha": head_sha,
        "runs": runs,
        "pull": pull,
    })))
}

fn failed(
    app: &AppHandle,
    root: &str,
    branch: &str,
    run_id: Option<&str>,
) -> Result<Reply, ForgeError> {
    let run_id = match run_id {
        Some(id) => id.to_string(),
        None => {
            let runs = forge::with_provider(app, root, |p, cx, r| p.runs(cx, r, Some(branch)))?;
            match newest_failed(&on_branch(runs, branch)) {
                Some(run) => run.id.clone(),
                None => return Ok(Reply::Refused(404, format!("No failed run on {branch}."))),
            }
        }
    };
    let text = forge::failure_text(app, root, &run_id)?;
    Ok(Reply::Ok(json!({ "runId": run_id, "text": text })))
}

fn log(app: &AppHandle, root: &str, run_id: &str, job_id: &str) -> Result<Reply, ForgeError> {
    let mut log = forge::with_provider(app, root, |p, cx, r| p.log(cx, r, run_id, job_id))?;
    log.first_error = diagnostic::first_error_line(&log.text).and_then(|i| u32::try_from(i).ok());
    Ok(Reply::Ok(json!(log)))
}

fn write(app: &AppHandle, root: &str, branch: &str, req: &CiRequest) -> Result<Reply, ForgeError> {
    let caps = forge::repo_of(app, root)?.capabilities;
    if let Err(msg) = write_supported(&caps, req.op, req.failed_only) {
        return Ok(Reply::Refused(400, msg));
    }
    let run_id = match &req.run_id {
        Some(id) => id.clone(),
        None => {
            let runs = forge::with_provider(app, root, |p, cx, r| p.runs(cx, r, Some(branch)))?;
            match on_branch(runs, branch).into_iter().next() {
                Some(run) => run.id,
                None => return Ok(Reply::Refused(404, format!("No run on {branch}."))),
            }
        }
    };
    forge::with_provider(app, root, |p, cx, r| match req.op {
        Op::Rerun => p.rerun(cx, r, &run_id, req.failed_only),
        _ => p.cancel(cx, r, &run_id),
    })?;
    Ok(Reply::Ok(json!({ "runId": run_id })))
}

/// Whether the host can do this write. Checked here because a host that cannot re-run only
/// the failed jobs (Bitbucket) would otherwise silently re-run everything.
fn write_supported(caps: &Capabilities, op: Op, failed_only: bool) -> Result<(), String> {
    let (ok, what) = match op {
        Op::Rerun if failed_only => (caps.rerun_failed, "re-running only the failed jobs of"),
        Op::Rerun => (caps.rerun, "re-running"),
        _ => (caps.cancel, "canceling"),
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "This host doesn't support {what} a {}.",
            caps.run_noun
        ))
    }
}

/// The host's runs for the branch, in its newest-first order. A run the host labels with
/// another branch is dropped in case a provider's branch filter is loose.
fn on_branch(runs: Vec<Run>, branch: &str) -> Vec<Run> {
    runs.into_iter()
        .filter(|r| r.branch.as_deref().is_none_or(|b| b == branch))
        .collect()
}

fn same_sha(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    // Some hosts report an abbreviated hash.
    a.len() >= 7 && b.len() >= 7 && (a.starts_with(&b) || b.starts_with(&a))
}

/// The newest run per workflow name for the head commit. Without a head SHA, or when the host
/// gives no SHA on any run, the newest per name on the branch stands in.
fn head_runs(runs: &[Run], head_sha: Option<&str>) -> Vec<Run> {
    let host_has_shas = runs.iter().any(|r| r.sha.is_some());
    let matches = |r: &Run| match head_sha {
        Some(head) if host_has_shas => r.sha.as_deref().is_some_and(|s| same_sha(s, head)),
        _ => true,
    };
    let mut seen = std::collections::HashSet::new();
    runs.iter()
        .filter(|r| matches(r))
        .filter(|r| seen.insert(r.name.as_str()))
        .cloned()
        .collect()
}

fn newest_failed(runs: &[Run]) -> Option<&Run> {
    runs.iter().find(|r| r.status == RunStatus::Failure)
}

/// The most recently opened pull request from this branch, in any state. Hosts list by last
/// update, so an old merged one touched by a late comment would otherwise win.
fn newest_pull<'a>(pulls: &'a [PullRequest], branch: &str) -> Option<&'a PullRequest> {
    pulls.iter().filter(|p| p.source_branch == branch).fold(
        None,
        |best: Option<&PullRequest>, p| match best {
            Some(b) if b.created_at >= p.created_at => Some(b),
            _ => Some(p),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::types::PullState;

    fn run(id: &str, name: &str, sha: Option<&str>, status: RunStatus) -> Run {
        Run {
            id: id.into(),
            number: None,
            name: name.into(),
            title: String::new(),
            branch: Some("main".into()),
            sha: sha.map(str::to_string),
            event: None,
            status,
            raw_status: String::new(),
            actor: None,
            created_at: String::new(),
            started_at: None,
            finished_at: None,
            web_url: String::new(),
        }
    }

    fn pull(id: &str, source: &str, created: &str, state: PullState) -> PullRequest {
        PullRequest {
            id: id.into(),
            number: 1,
            title: String::new(),
            author: String::new(),
            draft: false,
            state,
            source_branch: source.into(),
            target_branch: "main".into(),
            created_at: created.into(),
            updated_at: String::new(),
            web_url: String::new(),
            review_decision: None,
            reviewers: Vec::new(),
            checks: None,
            checks_pending: false,
            is_mine: false,
            review_requested: false,
        }
    }

    fn caps(rerun: bool, rerun_failed: bool, cancel: bool) -> Capabilities {
        Capabilities {
            rerun,
            rerun_failed,
            cancel,
            job_logs: true,
            drafts: true,
            pr_noun: "pull request".into(),
            run_noun: "pipeline".into(),
            min_poll_secs: 10,
            accounts: false,
        }
    }

    fn ids(runs: &[Run]) -> Vec<&str> {
        runs.iter().map(|r| r.id.as_str()).collect()
    }

    fn body(v: Value) -> Vec<u8> {
        v.to_string().into_bytes()
    }

    fn cwd() -> String {
        std::env::temp_dir().to_str().unwrap().to_string()
    }

    #[test]
    fn parse_reads_every_field() {
        let r = parse(&body(json!({
            "op": "rerun", "cwd": cwd(), "branch": " dev ", "runId": "7", "failedOnly": true
        })))
        .unwrap();
        assert_eq!(r.op, Op::Rerun);
        assert_eq!(r.branch.as_deref(), Some("dev"));
        assert_eq!(r.run_id.as_deref(), Some("7"));
        assert!(r.failed_only);
        let r = parse(&body(json!({ "op": "status", "cwd": cwd(), "branch": "" }))).unwrap();
        assert_eq!(r.branch, None);
    }

    #[test]
    fn parse_rejects_bad_requests() {
        let bad = [
            json!({ "op": "frob", "cwd": cwd() }),
            json!({ "op": "status" }),
            json!({ "op": "status", "cwd": "relative" }),
            json!({ "op": "status", "cwd": cwd(), "extra": 1 }),
            json!({ "op": "log", "cwd": cwd(), "runId": "1" }),
            json!({ "op": "cancel", "cwd": cwd(), "failedOnly": true }),
        ];
        for b in bad {
            assert!(parse(&body(b.clone())).is_err(), "{b}");
        }
        assert!(parse(b"not json").is_err());
        let missing = std::env::temp_dir().join("bashboard-ci-no-such-dir");
        let r = parse(&body(
            json!({ "op": "status", "cwd": missing.to_str().unwrap() }),
        ));
        assert!(r.unwrap_err().contains("does not exist"));
        assert!(
            parse(&body(
                json!({ "op": "log", "cwd": cwd(), "runId": "1", "jobId": "2" })
            ))
            .is_ok()
        );
    }

    #[test]
    fn head_runs_take_the_newest_per_name_on_the_head_sha() {
        let head = "abcdef1234567890";
        let runs = [
            run("5", "ci", Some("ffff000"), RunStatus::Running),
            run("4", "ci", Some(head), RunStatus::Failure),
            run("3", "lint", Some("ABCDEF1"), RunStatus::Success),
            run("2", "ci", Some(head), RunStatus::Success),
            run("1", "deploy", Some("0000000"), RunStatus::Success),
        ];
        assert_eq!(ids(&head_runs(&runs, Some(head))), ["4", "3"]);
        // No local head (another branch): newest per name on the branch.
        assert_eq!(ids(&head_runs(&runs, None)), ["5", "3", "1"]);
        // Nothing on the head yet: empty, which `bb ci wait` reads as "no run yet".
        assert!(head_runs(&runs, Some("9999999")).is_empty());
    }

    #[test]
    fn head_runs_fall_back_when_the_host_gives_no_sha() {
        let runs = [
            run("3", "ci", None, RunStatus::Running),
            run("2", "ci", None, RunStatus::Success),
            run("1", "lint", None, RunStatus::Success),
        ];
        assert_eq!(ids(&head_runs(&runs, Some("abcdef1"))), ["3", "1"]);
    }

    #[test]
    fn short_shas_do_not_match_everything() {
        assert!(same_sha("abcdef1", "ABCDEF1234"));
        assert!(!same_sha("abc", "abcdef1234"));
        assert!(!same_sha("abcdef2", "abcdef1234"));
    }

    #[test]
    fn on_branch_drops_runs_labeled_with_another_branch() {
        let mut other = run("2", "ci", None, RunStatus::Success);
        other.branch = Some("dev".into());
        let mut unlabeled = run("1", "ci", None, RunStatus::Success);
        unlabeled.branch = None;
        let runs = vec![run("3", "ci", None, RunStatus::Success), other, unlabeled];
        assert_eq!(ids(&on_branch(runs, "main")), ["3", "1"]);
    }

    #[test]
    fn newest_failed_skips_cancelled_and_passing_runs() {
        let runs = [
            run("4", "ci", None, RunStatus::Running),
            run("3", "ci", None, RunStatus::Cancelled),
            run("2", "ci", None, RunStatus::Failure),
            run("1", "ci", None, RunStatus::Failure),
        ];
        assert_eq!(newest_failed(&runs).map(|r| r.id.as_str()), Some("2"));
        assert!(newest_failed(&runs[..2]).is_none());
    }

    #[test]
    fn newest_pull_is_the_latest_opened_from_the_branch() {
        let pulls = [
            pull("old", "main", "2026-01-01T00:00:00Z", PullState::Merged),
            pull("other", "dev", "2026-09-01T00:00:00Z", PullState::Open),
            pull("new", "main", "2026-06-01T00:00:00Z", PullState::Open),
        ];
        assert_eq!(
            newest_pull(&pulls, "main").map(|p| p.id.as_str()),
            Some("new")
        );
        assert!(newest_pull(&pulls, "feature").is_none());
    }

    #[test]
    fn writes_follow_the_host_capabilities() {
        let bitbucket = caps(true, false, true);
        assert!(write_supported(&bitbucket, Op::Rerun, false).is_ok());
        let err = write_supported(&bitbucket, Op::Rerun, true).unwrap_err();
        assert!(err.contains("only the failed jobs"), "{err}");
        let azure = caps(false, true, true);
        assert!(write_supported(&azure, Op::Rerun, false).is_err());
        assert!(write_supported(&azure, Op::Rerun, true).is_ok());
        assert!(write_supported(&caps(true, true, false), Op::Cancel, false).is_err());
    }

    #[test]
    fn write_refusal_names_the_setting() {
        assert!(write_refusal(Op::Rerun).contains("ship.cliWrites"));
        assert!(write_refusal(Op::Cancel).contains("bb ci cancel"));
    }
}
