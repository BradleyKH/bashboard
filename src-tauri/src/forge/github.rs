//! The GitHub provider, for github.com and GitHub Enterprise Server (docs/design.md section
//! 3.20). Runs, jobs, logs, and the run actions use the REST API; open pull requests come from
//! one GraphQL query, since REST would need a request per pull request for its reviews and
//! checks. The JSON-to-DTO mapping is pure so it tests without the network.

use serde_json::{Value, json};

use super::remote::percent_encode;
use super::types::{
    Capabilities, ForgeError, ForgeErrorKind, Job, JobLog, ProviderKind, PullList, PullRequest,
    PullState, RepoRef, ReviewState, Reviewer, Run, RunStatus, Step,
};
use super::{Cx, ForgeProvider};

const LOG_TAIL_BYTES: usize = 1024 * 1024;
const ACCEPT: (&str, &str) = ("Accept", "application/vnd.github+json");

// `$head` is a nullable variable passed as null for every branch, which GitHub treats as no
// filter on `headRefName`.
const PULLS_QUERY: &str = "query($owner: String!, $name: String!, $states: [PullRequestState!], $head: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: $states, headRefName: $head, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        id number title state isDraft url createdAt updatedAt headRefName baseRefName reviewDecision
        author { login }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        latestReviews(first: 20) { nodes { author { login } state } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}";

pub struct GitHub;

fn is_dotcom(repo: &RepoRef) -> bool {
    let bare = repo.host.split(':').next().unwrap_or(&repo.host);
    bare.eq_ignore_ascii_case("github.com")
}

pub(super) fn api_base(repo: &RepoRef) -> String {
    if is_dotcom(repo) {
        "https://api.github.com".into()
    } else {
        format!("https://{}/api/v3", repo.host)
    }
}

fn graphql_url(repo: &RepoRef) -> String {
    if is_dotcom(repo) {
        "https://api.github.com/graphql".into()
    } else {
        format!("https://{}/api/graphql", repo.host)
    }
}

fn owner_name(repo: &RepoRef) -> Result<(&str, &str), ForgeError> {
    match repo.path.as_slice() {
        [owner, name] => Ok((owner, name)),
        _ => Err(ForgeError::other("A GitHub repo path is owner/name.")),
    }
}

fn repo_url(repo: &RepoRef, rest: &str) -> Result<String, ForgeError> {
    let (owner, name) = owner_name(repo)?;
    Ok(format!(
        "{}/repos/{}/{}{rest}",
        api_base(repo),
        percent_encode(owner),
        percent_encode(name)
    ))
}

fn bearer(cx: &Cx) -> String {
    format!("Bearer {}", cx.token.value)
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(k))?.as_str()
}

fn owned_at(v: &Value, path: &[&str]) -> Option<String> {
    str_at(v, path).map(str::to_string)
}

/// GitHub's numeric ids, as strings; a string id passes through.
fn id_of(v: &Value) -> String {
    match v.get("id") {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn nodes<'a>(v: &'a Value, path: &[&str]) -> &'a [Value] {
    path.iter()
        .try_fold(v, |v, k| v.get(k))
        .and_then(|n| n.get("nodes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// A run's, job's, or step's `status` and `conclusion`. The conclusion decides once the status
/// is `completed`, and also when a status is missing but a conclusion is set.
pub fn run_status(status: Option<&str>, conclusion: Option<&str>) -> RunStatus {
    use RunStatus as S;
    let finished = status == Some("completed") || (status.is_none() && conclusion.is_some());
    let key = if finished { conclusion } else { status };
    match key.unwrap_or("") {
        "queued" | "requested" | "pending" | "waiting" => S::Queued,
        "in_progress" => S::Running,
        "action_required" => S::Waiting,
        "success" => S::Success,
        "failure" | "timed_out" | "startup_failure" => S::Failure,
        "cancelled" => S::Cancelled,
        "skipped" => S::Skipped,
        _ => S::Other,
    }
}

/// The value `run_status` decided on, for display.
fn raw_status(status: Option<&str>, conclusion: Option<&str>) -> String {
    let finished = status == Some("completed") || status.is_none();
    match (finished, conclusion) {
        (true, Some(c)) => c.to_string(),
        _ => status.unwrap_or("").to_string(),
    }
}

pub fn map_run(v: &Value) -> Run {
    let status = str_at(v, &["status"]);
    let conclusion = str_at(v, &["conclusion"]);
    let title = owned_at(v, &["display_title"])
        .or_else(|| {
            str_at(v, &["head_commit", "message"])
                .map(|m| m.lines().next().unwrap_or("").to_string())
        })
        .unwrap_or_default();
    Run {
        id: id_of(v),
        number: v.get("run_number").and_then(Value::as_u64),
        name: owned_at(v, &["name"]).unwrap_or_default(),
        title,
        branch: owned_at(v, &["head_branch"]),
        sha: owned_at(v, &["head_sha"]),
        event: owned_at(v, &["event"]),
        status: run_status(status, conclusion),
        raw_status: raw_status(status, conclusion),
        actor: owned_at(v, &["actor", "login"]),
        created_at: owned_at(v, &["created_at"]).unwrap_or_default(),
        started_at: owned_at(v, &["run_started_at"]),
        // A run has no completion time of its own; its last update is when it finished.
        finished_at: if status == Some("completed") {
            owned_at(v, &["updated_at"])
        } else {
            None
        },
        web_url: owned_at(v, &["html_url"]).unwrap_or_default(),
    }
}

pub fn map_runs(v: &Value) -> Vec<Run> {
    v.get("workflow_runs")
        .and_then(Value::as_array)
        .map(|runs| runs.iter().map(map_run).collect())
        .unwrap_or_default()
}

fn map_step(v: &Value) -> Step {
    Step {
        number: v
            .get("number")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0),
        name: owned_at(v, &["name"]).unwrap_or_default(),
        status: run_status(str_at(v, &["status"]), str_at(v, &["conclusion"])),
    }
}

pub fn map_job(v: &Value) -> Job {
    Job {
        id: id_of(v),
        name: owned_at(v, &["name"]).unwrap_or_default(),
        status: run_status(str_at(v, &["status"]), str_at(v, &["conclusion"])),
        started_at: owned_at(v, &["started_at"]),
        finished_at: owned_at(v, &["completed_at"]),
        web_url: owned_at(v, &["html_url"]),
        steps: v
            .get("steps")
            .and_then(Value::as_array)
            .map(|s| s.iter().map(map_step).collect())
            .unwrap_or_default(),
    }
}

pub fn map_jobs(v: &Value) -> Vec<Job> {
    v.get("jobs")
        .and_then(Value::as_array)
        .map(|jobs| jobs.iter().map(map_job).collect())
        .unwrap_or_default()
}

/// GraphQL reports failure as HTTP 200 with an `errors` array, which `Http` cannot see.
pub fn graphql_error(v: &Value) -> Option<ForgeError> {
    use ForgeErrorKind as K;
    let first = v.get("errors")?.as_array()?.first()?;
    let kind = str_at(first, &["type"]).unwrap_or("");
    let message = str_at(first, &["message"]).unwrap_or("");
    let err = match kind {
        "NOT_FOUND" => ForgeError::new(K::NotFound, "GitHub could not find this repo."),
        "RATE_LIMITED" => ForgeError::new(K::RateLimited, "GitHub's rate limit was reached."),
        _ if message.contains("SAML") => ForgeError::new(
            K::SsoRequired,
            "This organization requires single sign-on. Authorize the token for it, then retry.",
        ),
        "FORBIDDEN" => ForgeError::new(K::Forbidden, "GitHub refused access to this repo."),
        _ => ForgeError::other(format!("GitHub could not list pull requests: {message}")),
    };
    Some(err)
}

fn review_decision(v: Option<&str>) -> Option<ReviewState> {
    match v? {
        "APPROVED" => Some(ReviewState::Approved),
        "CHANGES_REQUESTED" => Some(ReviewState::ChangesRequested),
        "REVIEW_REQUIRED" => Some(ReviewState::Pending),
        _ => None,
    }
}

fn review_state(v: &str) -> ReviewState {
    match v {
        "APPROVED" => ReviewState::Approved,
        "CHANGES_REQUESTED" => ReviewState::ChangesRequested,
        _ => ReviewState::Pending,
    }
}

fn rollup_status(v: Option<&str>) -> Option<RunStatus> {
    match v? {
        "SUCCESS" => Some(RunStatus::Success),
        "FAILURE" | "ERROR" => Some(RunStatus::Failure),
        "PENDING" | "EXPECTED" => Some(RunStatus::Running),
        _ => Some(RunStatus::Other),
    }
}

fn pull_state(v: Option<&str>) -> PullState {
    match v {
        Some("MERGED") => PullState::Merged,
        Some("CLOSED") => PullState::Closed,
        _ => PullState::Open,
    }
}

fn map_pull(v: &Value, viewer: Option<&str>) -> PullRequest {
    let is_viewer = |login: &str| viewer.is_some_and(|me| me.eq_ignore_ascii_case(login));
    // Team requests come back as empty objects, since the query only asks for users.
    let requested: Vec<String> = nodes(v, &["reviewRequests"])
        .iter()
        .filter_map(|n| owned_at(n, &["requestedReviewer", "login"]))
        .collect();
    // A reviewer asked again after reviewing is pending, whatever their last review said.
    let mut reviewers: Vec<Reviewer> = requested
        .iter()
        .map(|login| Reviewer {
            login: login.clone(),
            state: ReviewState::Pending,
        })
        .collect();
    for r in nodes(v, &["latestReviews"]) {
        let Some(login) = str_at(r, &["author", "login"]) else {
            continue;
        };
        if reviewers
            .iter()
            .any(|x| x.login.eq_ignore_ascii_case(login))
        {
            continue;
        }
        reviewers.push(Reviewer {
            login: login.to_string(),
            state: review_state(str_at(r, &["state"]).unwrap_or("")),
        });
    }
    let number = v.get("number").and_then(Value::as_u64).unwrap_or(0);
    // A deleted account's pull request has a null author; GitHub shows it as "ghost".
    let author = owned_at(v, &["author", "login"]).unwrap_or_else(|| "ghost".into());
    let checks = rollup_status(
        nodes(v, &["commits"])
            .first()
            .and_then(|n| str_at(n, &["commit", "statusCheckRollup", "state"])),
    );
    PullRequest {
        id: owned_at(v, &["id"]).unwrap_or_else(|| number.to_string()),
        number,
        title: owned_at(v, &["title"]).unwrap_or_default(),
        is_mine: is_viewer(&author),
        author,
        draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        state: pull_state(str_at(v, &["state"])),
        source_branch: owned_at(v, &["headRefName"]).unwrap_or_default(),
        target_branch: owned_at(v, &["baseRefName"]).unwrap_or_default(),
        created_at: owned_at(v, &["createdAt"]).unwrap_or_default(),
        updated_at: owned_at(v, &["updatedAt"]).unwrap_or_default(),
        web_url: owned_at(v, &["url"]).unwrap_or_default(),
        review_decision: review_decision(str_at(v, &["reviewDecision"])),
        reviewers,
        checks,
        // The GraphQL query carries the rollup, so nothing is left to fetch.
        checks_pending: false,
        review_requested: requested.iter().any(|l| is_viewer(l)),
    }
}

/// The GraphQL reply's pull requests and total open count, or the error it carries.
/// The repo endpoint's `default_branch`.
pub fn map_default_branch(v: &Value) -> Option<String> {
    owned_at(v, &["default_branch"]).filter(|b| !b.is_empty())
}

pub fn map_pulls(v: &Value) -> Result<PullList, ForgeError> {
    if let Some(e) = graphql_error(v) {
        return Err(e);
    }
    let data = v.get("data").unwrap_or(&Value::Null);
    if data.get("repository").is_none_or(Value::is_null) {
        return Err(ForgeError::new(
            ForgeErrorKind::NotFound,
            "GitHub could not find this repo.",
        ));
    }
    let viewer = str_at(data, &["viewer", "login"]);
    let items = nodes(data, &["repository", "pullRequests"])
        .iter()
        .map(|p| map_pull(p, viewer))
        .collect();
    let total = data
        .pointer("/repository/pullRequests/totalCount")
        .and_then(Value::as_u64);
    Ok(PullList { items, total })
}

impl ForgeProvider for GitHub {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Github
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            rerun: true,
            rerun_failed: true,
            cancel: true,
            job_logs: true,
            drafts: true,
            pr_noun: "pull request".into(),
            run_noun: "workflow run".into(),
            min_poll_secs: 10,
            accounts: true,
        }
    }

    fn runs(&self, cx: &Cx, repo: &RepoRef, branch: Option<&str>) -> Result<Vec<Run>, ForgeError> {
        let mut rest = "/actions/runs?per_page=20".to_string();
        if let Some(b) = branch {
            rest.push_str("&branch=");
            rest.push_str(&percent_encode(b));
        }
        let v: Value = cx
            .http
            .get_json(&repo_url(repo, &rest)?, Some(&bearer(cx)), &[ACCEPT])?;
        Ok(map_runs(&v))
    }

    fn jobs(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<Vec<Job>, ForgeError> {
        let rest = format!("/actions/runs/{}/jobs?per_page=100", percent_encode(run_id));
        let v: Value = cx
            .http
            .get_json(&repo_url(repo, &rest)?, Some(&bearer(cx)), &[ACCEPT])?;
        Ok(map_jobs(&v))
    }

    fn log(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        _run_id: &str,
        job_id: &str,
    ) -> Result<JobLog, ForgeError> {
        let rest = format!("/actions/jobs/{}/logs", percent_encode(job_id));
        let (text, truncated) = cx.http.get_text_tail(
            &repo_url(repo, &rest)?,
            Some(&bearer(cx)),
            &[ACCEPT],
            LOG_TAIL_BYTES,
        )?;
        Ok(JobLog { text, truncated })
    }

    fn rerun(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        run_id: &str,
        failed_only: bool,
    ) -> Result<(), ForgeError> {
        let action = if failed_only {
            "rerun-failed-jobs"
        } else {
            "rerun"
        };
        let rest = format!("/actions/runs/{}/{action}", percent_encode(run_id));
        cx.http
            .post_json(&repo_url(repo, &rest)?, Some(&bearer(cx)), &[ACCEPT], None)?;
        Ok(())
    }

    fn cancel(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<(), ForgeError> {
        let rest = format!("/actions/runs/{}/cancel", percent_encode(run_id));
        cx.http
            .post_json(&repo_url(repo, &rest)?, Some(&bearer(cx)), &[ACCEPT], None)?;
        Ok(())
    }

    fn pulls(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        open_only: bool,
        branch: Option<&str>,
    ) -> Result<PullList, ForgeError> {
        let (owner, name) = owner_name(repo)?;
        let states = if open_only {
            json!(["OPEN"])
        } else {
            json!(["OPEN", "CLOSED", "MERGED"])
        };
        let body = json!({
            "query": PULLS_QUERY,
            "variables": { "owner": owner, "name": name, "states": states, "head": branch },
        });
        let v = cx.http.post_json(
            &graphql_url(repo),
            Some(&bearer(cx)),
            &[ACCEPT],
            Some(&body),
        )?;
        map_pulls(&v)
    }

    fn default_branch(&self, cx: &Cx, repo: &RepoRef) -> Result<Option<String>, ForgeError> {
        let v: Value = cx
            .http
            .get_json(&repo_url(repo, "")?, Some(&bearer(cx)), &[ACCEPT])?;
        Ok(map_default_branch(&v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use RunStatus as S;

    fn repo(host: &str) -> RepoRef {
        RepoRef {
            provider: ProviderKind::Github,
            host: host.into(),
            path: vec!["o".into(), "r".into()],
            web_url: String::new(),
        }
    }

    #[test]
    fn api_bases_for_dotcom_and_enterprise() {
        assert_eq!(api_base(&repo("github.com")), "https://api.github.com");
        assert_eq!(
            graphql_url(&repo("GitHub.com")),
            "https://api.github.com/graphql"
        );
        assert_eq!(
            api_base(&repo("ghe.corp:8443")),
            "https://ghe.corp:8443/api/v3"
        );
        assert_eq!(
            graphql_url(&repo("ghe.corp")),
            "https://ghe.corp/api/graphql"
        );
        assert_eq!(
            repo_url(&repo("github.com"), "/actions/runs").unwrap(),
            "https://api.github.com/repos/o/r/actions/runs"
        );
        let mut bad = repo("github.com");
        bad.path = vec!["only".into()];
        assert!(repo_url(&bad, "").is_err());
    }

    #[test]
    fn every_status_and_conclusion() {
        let open: &[(&str, RunStatus)] = &[
            ("queued", S::Queued),
            ("requested", S::Queued),
            ("pending", S::Queued),
            ("waiting", S::Queued),
            ("in_progress", S::Running),
            ("something_new", S::Other),
        ];
        for (status, want) in open {
            assert_eq!(run_status(Some(status), None), *want, "{status}");
            // A conclusion left over from an earlier attempt does not count until completed.
            assert_eq!(run_status(Some(status), Some("success")), *want, "{status}");
        }
        let done: &[(&str, RunStatus)] = &[
            ("action_required", S::Waiting),
            ("success", S::Success),
            ("failure", S::Failure),
            ("timed_out", S::Failure),
            ("startup_failure", S::Failure),
            ("cancelled", S::Cancelled),
            ("skipped", S::Skipped),
            ("neutral", S::Other),
            ("stale", S::Other),
        ];
        for (conclusion, want) in done {
            assert_eq!(
                run_status(Some("completed"), Some(conclusion)),
                *want,
                "{conclusion}"
            );
            assert_eq!(raw_status(Some("completed"), Some(conclusion)), *conclusion);
        }
        assert_eq!(run_status(Some("completed"), None), S::Other);
        assert_eq!(run_status(None, Some("success")), S::Success);
        assert_eq!(run_status(None, None), S::Other);
        assert_eq!(raw_status(Some("in_progress"), None), "in_progress");
    }

    #[test]
    fn maps_a_completed_run() {
        let v = json!({ "workflow_runs": [{
            "id": 123456789012u64,
            "name": "CI",
            "display_title": "Fix the thing",
            "run_number": 42,
            "head_branch": "main",
            "head_sha": "abc123",
            "event": "push",
            "status": "completed",
            "conclusion": "timed_out",
            "actor": { "login": "octo" },
            "created_at": "2026-11-01T10:00:00Z",
            "run_started_at": "2026-11-01T10:00:05Z",
            "updated_at": "2026-11-01T10:09:00Z",
            "html_url": "https://github.com/o/r/actions/runs/123456789012"
        }]});
        let runs = map_runs(&v);
        assert_eq!(runs.len(), 1);
        let r = &runs[0];
        assert_eq!(r.id, "123456789012");
        assert_eq!(r.number, Some(42));
        assert_eq!((r.name.as_str(), r.title.as_str()), ("CI", "Fix the thing"));
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(r.sha.as_deref(), Some("abc123"));
        assert_eq!(r.event.as_deref(), Some("push"));
        assert_eq!((r.status, r.raw_status.as_str()), (S::Failure, "timed_out"));
        assert_eq!(r.actor.as_deref(), Some("octo"));
        assert_eq!(r.created_at, "2026-11-01T10:00:00Z");
        assert_eq!(r.started_at.as_deref(), Some("2026-11-01T10:00:05Z"));
        assert_eq!(r.finished_at.as_deref(), Some("2026-11-01T10:09:00Z"));
        assert_eq!(
            r.web_url,
            "https://github.com/o/r/actions/runs/123456789012"
        );
    }

    #[test]
    fn running_run_with_missing_optionals() {
        let v = json!({
            "id": 7,
            "status": "in_progress",
            "conclusion": null,
            "head_branch": null,
            "actor": null,
            "updated_at": "2026-11-01T10:09:00Z",
            "head_commit": { "message": "First line\n\nBody" }
        });
        let r = map_run(&v);
        assert_eq!(r.id, "7");
        assert_eq!(r.status, S::Running);
        assert_eq!(r.raw_status, "in_progress");
        assert_eq!(r.title, "First line");
        assert_eq!(r.number, None);
        assert_eq!(r.branch, None);
        assert_eq!(r.actor, None);
        assert_eq!(r.started_at, None);
        assert_eq!(r.finished_at, None, "an unfinished run has no finish time");
        assert_eq!((r.name.as_str(), r.created_at.as_str()), ("", ""));
        assert!(map_runs(&json!({})).is_empty());
    }

    #[test]
    fn maps_jobs_with_steps() {
        let v = json!({ "total_count": 2, "jobs": [
            {
                "id": 99,
                "name": "build",
                "status": "completed",
                "conclusion": "failure",
                "started_at": "2026-11-01T10:00:10Z",
                "completed_at": "2026-11-01T10:05:00Z",
                "html_url": "https://github.com/o/r/actions/runs/7/job/99",
                "steps": [
                    { "name": "Set up job", "status": "completed", "conclusion": "success", "number": 1 },
                    { "name": "Test", "status": "completed", "conclusion": "failure", "number": 2 },
                    { "name": "Post", "status": "completed", "conclusion": "skipped", "number": 3 }
                ]
            },
            { "id": 100, "name": "lint", "status": "queued", "conclusion": null }
        ]});
        let jobs = map_jobs(&v);
        assert_eq!(jobs.len(), 2);
        let j = &jobs[0];
        assert_eq!(
            (j.id.as_str(), j.name.as_str(), j.status),
            ("99", "build", S::Failure)
        );
        assert_eq!(j.finished_at.as_deref(), Some("2026-11-01T10:05:00Z"));
        assert_eq!(
            j.steps
                .iter()
                .map(|s| (s.number, s.status))
                .collect::<Vec<_>>(),
            vec![(1, S::Success), (2, S::Failure), (3, S::Skipped)]
        );
        assert_eq!(jobs[1].status, S::Queued);
        assert!(jobs[1].steps.is_empty());
        assert_eq!(jobs[1].web_url, None);
    }

    fn pull(extra: Value) -> Value {
        let mut base = json!({
            "id": "PR_kwDOA",
            "number": 5,
            "title": "Add things",
            "isDraft": false,
            "url": "https://github.com/o/r/pull/5",
            "createdAt": "2026-11-01T00:00:00Z",
            "updatedAt": "2026-11-02T00:00:00Z",
            "headRefName": "feature",
            "baseRefName": "main",
            "reviewDecision": null,
            "author": { "login": "alice" },
            "reviewRequests": { "nodes": [] },
            "latestReviews": { "nodes": [] },
            "commits": { "nodes": [] }
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    fn reply(viewer: &str, pulls: Vec<Value>) -> Value {
        json!({ "data": {
            "viewer": { "login": viewer },
            "repository": { "pullRequests": { "totalCount": 60, "nodes": pulls } }
        }})
    }

    #[test]
    fn maps_each_review_decision_and_rollup() {
        let cases: &[(Value, Option<ReviewState>)] = &[
            (json!("APPROVED"), Some(ReviewState::Approved)),
            (
                json!("CHANGES_REQUESTED"),
                Some(ReviewState::ChangesRequested),
            ),
            (json!("REVIEW_REQUIRED"), Some(ReviewState::Pending)),
            (Value::Null, None),
        ];
        for (decision, want) in cases {
            let v = reply("bob", vec![pull(json!({ "reviewDecision": decision }))]);
            assert_eq!(
                map_pulls(&v).unwrap().items[0].review_decision,
                *want,
                "{decision}"
            );
        }
        let rollups: &[(&str, RunStatus)] = &[
            ("SUCCESS", S::Success),
            ("FAILURE", S::Failure),
            ("ERROR", S::Failure),
            ("PENDING", S::Running),
            ("EXPECTED", S::Running),
        ];
        for (state, want) in rollups {
            let commits =
                json!({ "nodes": [{ "commit": { "statusCheckRollup": { "state": state } } }] });
            let v = reply("bob", vec![pull(json!({ "commits": commits }))]);
            assert_eq!(
                map_pulls(&v).unwrap().items[0].checks,
                Some(*want),
                "{state}"
            );
        }
        let no_checks = json!({ "nodes": [{ "commit": { "statusCheckRollup": null } }] });
        let v = reply("bob", vec![pull(json!({ "commits": no_checks }))]);
        assert_eq!(map_pulls(&v).unwrap().items[0].checks, None);
    }

    #[test]
    fn maps_each_pull_state() {
        let cases = [
            ("OPEN", PullState::Open),
            ("MERGED", PullState::Merged),
            ("CLOSED", PullState::Closed),
        ];
        for (state, want) in cases {
            let v = reply("bob", vec![pull(json!({ "state": state }))]);
            assert_eq!(map_pulls(&v).unwrap().items[0].state, want, "{state}");
        }
        // An older server or a trimmed reply without the field reads as open.
        let v = reply("bob", vec![pull(json!({}))]);
        assert_eq!(map_pulls(&v).unwrap().items[0].state, PullState::Open);
    }

    #[test]
    fn total_is_the_connections_total_count() {
        let v = reply("bob", vec![pull(json!({}))]);
        let list = map_pulls(&v).unwrap();
        assert_eq!((list.items.len(), list.total), (1, Some(60)));
        let bare = json!({ "data": { "viewer": { "login": "a" }, "repository": { "pullRequests": { "nodes": [] } } } });
        assert_eq!(map_pulls(&bare).unwrap().total, None);
    }

    #[test]
    fn maps_a_full_pull_request() {
        let v = reply(
            "Bob",
            vec![pull(json!({
                "reviewDecision": "CHANGES_REQUESTED",
                "reviewRequests": { "nodes": [
                    { "requestedReviewer": { "login": "bob" } },
                    { "requestedReviewer": {} }
                ]},
                "latestReviews": { "nodes": [
                    { "author": { "login": "carol" }, "state": "CHANGES_REQUESTED" },
                    { "author": { "login": "dave" }, "state": "APPROVED" },
                    { "author": { "login": "erin" }, "state": "COMMENTED" },
                    { "author": { "login": "bob" }, "state": "APPROVED" }
                ]}
            }))],
        );
        let p = &map_pulls(&v).unwrap().items[0];
        assert_eq!((p.id.as_str(), p.number), ("PR_kwDOA", 5));
        assert_eq!(p.title, "Add things");
        assert_eq!(p.author, "alice");
        assert!(!p.draft);
        assert_eq!(
            (p.source_branch.as_str(), p.target_branch.as_str()),
            ("feature", "main")
        );
        assert_eq!(p.created_at, "2026-11-01T00:00:00Z");
        assert_eq!(p.updated_at, "2026-11-02T00:00:00Z");
        assert_eq!(p.web_url, "https://github.com/o/r/pull/5");
        assert!(!p.is_mine);
        assert!(p.review_requested, "the viewer is asked to review");
        // Bob was asked again after approving, so he is pending; the team request is skipped.
        assert_eq!(
            p.reviewers
                .iter()
                .map(|r| (r.login.as_str(), r.state))
                .collect::<Vec<_>>(),
            vec![
                ("bob", ReviewState::Pending),
                ("carol", ReviewState::ChangesRequested),
                ("dave", ReviewState::Approved),
                ("erin", ReviewState::Pending),
            ]
        );
    }

    #[test]
    fn draft_mine_and_missing_fields() {
        let v = reply("alice", vec![pull(json!({ "isDraft": true }))]);
        let p = &map_pulls(&v).unwrap().items[0];
        assert!(p.draft && p.is_mine && !p.review_requested);
        assert!(p.reviewers.is_empty());
        assert_eq!(p.checks, None);

        let bare = json!({ "data": {
            "viewer": null,
            "repository": { "pullRequests": { "nodes": [{ "number": 9, "author": null }] } }
        }});
        let p = &map_pulls(&bare).unwrap().items[0];
        assert_eq!(
            (p.id.as_str(), p.number, p.author.as_str()),
            ("9", 9, "ghost")
        );
        assert!(!p.is_mine && !p.review_requested && !p.draft);
        assert_eq!(p.review_decision, None);
        assert!(p.title.is_empty() && p.web_url.is_empty());

        let empty = json!({ "data": { "viewer": { "login": "a" }, "repository": { "pullRequests": { "nodes": [] } } } });
        assert!(map_pulls(&empty).unwrap().items.is_empty());
    }

    #[test]
    fn graphql_errors_map_to_kinds() {
        let err = |t: &str, m: &str| json!({ "data": { "repository": null }, "errors": [{ "type": t, "message": m }] });
        let kind = |v: Value| map_pulls(&v).unwrap_err().kind;
        assert_eq!(
            kind(err("NOT_FOUND", "Could not resolve to a Repository")),
            ForgeErrorKind::NotFound
        );
        assert_eq!(
            kind(err("RATE_LIMITED", "slow")),
            ForgeErrorKind::RateLimited
        );
        assert_eq!(kind(err("FORBIDDEN", "nope")), ForgeErrorKind::Forbidden);
        assert_eq!(
            kind(err(
                "FORBIDDEN",
                "Resource protected by organization SAML enforcement."
            )),
            ForgeErrorKind::SsoRequired
        );
        let e = map_pulls(&err("SOMETHING", "odd")).unwrap_err();
        assert_eq!(e.kind, ForgeErrorKind::Other);
        assert!(e.message.contains("odd"));
        // No errors, but no repository either.
        assert_eq!(
            kind(json!({ "data": { "viewer": { "login": "a" }, "repository": null } })),
            ForgeErrorKind::NotFound
        );
        assert_eq!(kind(json!({})), ForgeErrorKind::NotFound);
    }

    /// Live: runs and pull requests for this repo with `gh auth token`, printing counts only.
    /// `cargo test forge::github -- --ignored --nocapture`.
    #[test]
    fn default_branch_from_the_repo_endpoint() {
        assert_eq!(
            map_default_branch(&json!({"name": "b", "default_branch": "main"})).as_deref(),
            Some("main")
        );
        assert_eq!(map_default_branch(&json!({"default_branch": ""})), None);
        assert_eq!(map_default_branch(&json!({})), None);
    }

    #[test]
    #[ignore]
    fn live_runs_and_pulls() {
        use super::super::auth::TokenSource;
        use super::super::http::Http;
        use super::super::types::Token;
        let out = std::process::Command::new("gh")
            .args(["auth", "token", "--hostname", "github.com"])
            .output()
            .expect("gh runs");
        assert!(out.status.success(), "gh auth token failed");
        let token = Token {
            value: String::from_utf8(out.stdout).unwrap().trim().to_string(),
            source: TokenSource::Cli {
                program: "gh".into(),
                args: Vec::new(),
            },
            expires: None,
        };
        let http = Http::default();
        let cx = Cx {
            http: &http,
            token: &token,
        };
        let r = RepoRef {
            provider: ProviderKind::Github,
            host: "github.com".into(),
            path: vec!["BradleyKH".into(), "bashboard".into()],
            web_url: "https://github.com/BradleyKH/bashboard".into(),
        };
        let runs = GitHub.runs(&cx, &r, None).unwrap();
        assert!(!runs.is_empty(), "expected at least one run");
        assert!(
            runs.iter()
                .all(|r| !r.id.is_empty() && !r.web_url.is_empty())
        );
        let pulls = GitHub.pulls(&cx, &r, true, None).unwrap();
        assert!(
            pulls.total.is_some_and(|t| t >= pulls.items.len() as u64),
            "the list reports a total at least as large as the page"
        );
        println!(
            "live: {} runs, {} of {:?} open pull requests",
            runs.len(),
            pulls.items.len(),
            pulls.total
        );
        // The overview through a remote target, as the Overview tab asks for it.
        let g = crate::git::test_support::repo("github-live-overview");
        let home = std::env::var("USERPROFILE").expect("USERPROFILE");
        let git = g.at(home.into());
        let hosts_yml = super::super::remote::read_gh_hosts_yml().unwrap_or_default();
        let state = super::super::ForgeState::default();
        let target = "remote:github.com/BradleyKH/bashboard";
        let r = state
            .cached(target, || {
                super::super::resolve_remote(
                    target.trim_start_matches(super::super::REMOTE_PREFIX),
                    &Default::default(),
                    &hosts_yml,
                )
            })
            .unwrap();
        let started = std::time::Instant::now();
        let o = super::super::overview(&state, &git, &r).unwrap();
        let took = started.elapsed();
        assert_eq!(o.repo.branch, None);
        assert_eq!(o.default_branch.as_deref(), Some("main"));
        assert!(!o.runs.is_empty() && o.runs.len() <= 20);
        let started = std::time::Instant::now();
        super::super::overview(&state, &git, &r).unwrap();
        println!(
            "live overview: {} runs, {} open pull requests, default branch found, {took:?} cold, {:?} warm",
            o.runs.len(),
            o.pulls.items.len(),
            started.elapsed()
        );
    }
}
