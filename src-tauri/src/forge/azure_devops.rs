//! Azure DevOps Services (docs/design/ship.md section 3.20), over the REST API at
//! `https://dev.azure.com/{org}` with `api-version` on every call. The JSON-to-DTO mapping and
//! the requests that change a build (cancel, re-run) are pure functions, so they test without
//! the network.

use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{LazyLock, Mutex};

use serde_json::{Value, json};

use super::auth::TokenSource;
use super::remote::percent_encode;
use super::types::{
    Capabilities, ForgeError, ForgeErrorKind, Job, JobLog, ProviderKind, PullChecks,
    PullChecksQuery, PullList, PullRequest, PullState, RepoRef, ReviewState, Reviewer, Run,
    RunStatus, Step, Token,
};
use super::{Cx, ForgeProvider};
use crate::lock::LockExt;

pub struct AzureDevOps;

const API_HOST: &str = "https://dev.azure.com";
const API_VERSION: &str = "7.1";
/// connectionData and policy evaluations answer a plain `7.1` with a 400.
const PREVIEW_VERSION: &str = "7.1-preview";
const LOG_MAX: usize = 1024 * 1024;
const RUNS_TOP: usize = 20;
const PULLS_TOP: usize = 50;
/// Without the suppress header, a rejected token gets a 302 to the sign-in page on another
/// host instead of a 401.
const HEADERS: &[(&str, &str)] = &[
    ("Accept", "application/json"),
    ("X-TFS-FedAuthRedirect", "Suppress"),
];
/// The build log endpoint answers `application/json` with the lines as one JSON array, so the
/// log download asks for the plain text instead.
const LOG_HEADERS: &[(&str, &str)] = &[
    ("Accept", "text/plain"),
    ("X-TFS-FedAuthRedirect", "Suppress"),
];
/// The policy types that are CI checks: Build validation and external Status checks. Reviewer
/// and work item policies already show as the review state, or aren't checks at all.
const BUILD_POLICY: &str = "0609b952-1397-4640-95ec-e00a01b2c241";
const STATUS_POLICY: &str = "cbdc66da-9728-4af8-aada-9a5a32e4a226";

/// The PAT scope cancel and re-run need; reading alone needs only Build (Read).
pub(super) const SCOPE_BUILD_EXECUTE: &str = "Build (Read & execute)";
pub(super) const SCOPE_BUILD_READ: &str = "Build (Read)";

/// A repo's ids by lowercased `(org, project, repo)`, resolved once; only a success is cached.
static REPOS: LazyLock<Mutex<HashMap<(String, String, String), RepoInfo>>> =
    LazyLock::new(Default::default);
/// The (token hash, repo key) pairs whose repo lookup succeeded, never the token itself. A
/// cached repo id proves nothing about a later caller's token, so a build endpoint's 401 is
/// read as a missing scope only for a token listed here.
static REPO_READERS: LazyLock<Mutex<HashSet<(u64, String)>>> = LazyLock::new(Default::default);
/// The viewer's identity id per (token hash, org), never the token itself.
static VIEWERS: LazyLock<Mutex<HashMap<(u64, String), Option<String>>>> =
    LazyLock::new(Default::default);
/// A pull request's policy check rollup by (repo key, PR id), with the source commit it was
/// fetched at. A pull request has no updated time, so only a settled rollup for an unchanged
/// commit is reused; a queued or running one is asked again on the next poll.
type ChecksCache = HashMap<(String, u64), (String, Option<RunStatus>)>;
static CHECKS: LazyLock<Mutex<ChecksCache>> = LazyLock::new(Default::default);
/// Each listed pull request's source commit, so `pull_checks` can file what it fetches.
static SOURCES: LazyLock<Mutex<HashMap<(String, u64), String>>> = LazyLock::new(Default::default);
/// Past this many entries a cache starts over rather than growing for the session.
const CACHE_MAX: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    pub id: String,
    pub project_id: String,
    pub default_branch: Option<String>,
}

/// A request that changes something on the host, built apart from sending it.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub body: Value,
}

pub(super) fn token_page_url(org: &str) -> String {
    format!(
        "https://dev.azure.com/{}/_usersSettings/tokens",
        super::remote::percent_encode(org)
    )
}

/// A `forbidden` error naming the PAT scope the call needed.
pub(super) fn missing_scope(scope: &str) -> ForgeError {
    ForgeError::new(
        ForgeErrorKind::Forbidden,
        format!("This token is missing the {scope} scope."),
    )
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// An Entra token, as Git Credential Manager returns one when `credential.azreposCredentialType`
/// is `oauth`: three dot-separated base64url parts, the header's JSON starting `eyJ`.
fn is_jwt(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && value.starts_with("eyJ")
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'='))
        })
}

/// The `Authorization` value for a token by where it came from. A PAT goes as Basic with an
/// empty user name; Azure DevOps takes an Entra token only as Bearer, and a PAT only as Basic.
pub(super) fn auth_header(token: &Token) -> String {
    let basic = |v: &str| format!("Basic {}", base64(format!(":{v}").as_bytes()));
    match &token.source {
        TokenSource::AzCli => format!("Bearer {}", token.value),
        TokenSource::GitCredential { .. } if is_jwt(&token.value) => {
            format!("Bearer {}", token.value)
        }
        _ => basic(&token.value),
    }
}

fn str_at<'a>(v: &'a Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn string_at(v: &Value, ptr: &str) -> Option<String> {
    str_at(v, ptr).map(str::to_string)
}

fn first_line(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

fn short_ref(r: &str) -> &str {
    r.strip_prefix("refs/heads/").unwrap_or(r)
}

/// `url` with `api-version` appended.
fn versioned(url: String, version: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}api-version={version}")
}

/// `[org, project, repo]`, each percent-encoded for a path segment.
fn segments(repo: &RepoRef) -> Result<[String; 3], ForgeError> {
    match repo.path.as_slice() {
        [org, proj, name] => Ok([
            percent_encode(org),
            percent_encode(proj),
            percent_encode(name),
        ]),
        _ => Err(ForgeError::other(
            "An Azure DevOps repo path is an organization, a project, and a repo.",
        )),
    }
}

fn repo_key(repo: &RepoRef) -> String {
    repo.path.join("/").to_lowercase()
}

/// A build id is a number; refusing anything else keeps the id out of the path's structure.
fn build_id(run_id: &str) -> Result<u64, ForgeError> {
    run_id
        .parse::<u64>()
        .map_err(|_| ForgeError::other("That isn't an Azure DevOps build id."))
}

fn project_base(org: &str, proj: &str) -> String {
    format!("{API_HOST}/{org}/{proj}")
}

pub fn repo_url(org: &str, proj: &str, name: &str) -> String {
    versioned(
        format!("{}/_apis/git/repositories/{name}", project_base(org, proj)),
        API_VERSION,
    )
}

pub fn connection_url(org: &str) -> String {
    versioned(
        format!("{API_HOST}/{org}/_apis/connectionData"),
        PREVIEW_VERSION,
    )
}

pub fn builds_url(org: &str, proj: &str, repo_id: &str, branch: Option<&str>) -> String {
    let mut url = format!(
        "{}/_apis/build/builds?repositoryId={}&repositoryType=TfsGit",
        project_base(org, proj),
        percent_encode(repo_id)
    );
    if let Some(b) = branch {
        url.push_str(&format!(
            "&branchName={}",
            percent_encode(&format!("refs/heads/{b}"))
        ));
    }
    url.push_str(&format!("&$top={RUNS_TOP}"));
    versioned(url, API_VERSION)
}

pub fn timeline_url(org: &str, proj: &str, id: u64) -> String {
    versioned(
        format!(
            "{}/_apis/build/builds/{id}/timeline",
            project_base(org, proj)
        ),
        API_VERSION,
    )
}

pub fn log_url(org: &str, proj: &str, id: u64, log_id: u64) -> String {
    versioned(
        format!(
            "{}/_apis/build/builds/{id}/logs/{log_id}",
            project_base(org, proj)
        ),
        API_VERSION,
    )
}

pub fn pulls_url(
    org: &str,
    proj: &str,
    repo_id: &str,
    open_only: bool,
    branch: Option<&str>,
) -> String {
    let status = if open_only { "active" } else { "all" };
    let mut url = format!(
        "{}/_apis/git/repositories/{}/pullrequests?searchCriteria.status={status}",
        project_base(org, proj),
        percent_encode(repo_id)
    );
    if let Some(b) = branch {
        url.push_str(&format!(
            "&searchCriteria.sourceRefName={}",
            percent_encode(&format!("refs/heads/{b}"))
        ));
    }
    url.push_str(&format!("&$top={PULLS_TOP}"));
    versioned(url, API_VERSION)
}

/// A pull request's policy evaluations, which name it by the project's GUID, not its name.
pub fn policy_url(org: &str, proj: &str, project_id: &str, pr: u64) -> String {
    let artifact = format!("vstfs:///CodeReview/CodeReviewId/{project_id}/{pr}");
    versioned(
        format!(
            "{}/_apis/policy/evaluations?artifactId={}",
            project_base(org, proj),
            percent_encode(&artifact)
        ),
        PREVIEW_VERSION,
    )
}

/// Asks a build to stop; the host moves it to `cancelling`, then `completed` and `canceled`.
pub fn cancel_request(org: &str, proj: &str, id: u64) -> Request {
    Request {
        method: "PATCH",
        url: versioned(
            format!("{}/_apis/build/builds/{id}", project_base(org, proj)),
            API_VERSION,
        ),
        body: json!({ "status": "cancelling" }),
    }
}

/// Re-runs a finished build's failed stages, in the same build.
pub fn retry_request(org: &str, proj: &str, id: u64) -> Request {
    Request {
        method: "PATCH",
        url: versioned(
            format!(
                "{}/_apis/build/builds/{id}?retry=true",
                project_base(org, proj)
            ),
            API_VERSION,
        ),
        body: json!({}),
    }
}

pub fn map_repo(v: &Value) -> Option<RepoInfo> {
    Some(RepoInfo {
        id: string_at(v, "/id")?,
        project_id: string_at(v, "/project/id")?,
        default_branch: str_at(v, "/defaultBranch").map(|b| short_ref(b).to_string()),
    })
}

/// `authenticatedUser.id` of connectionData, the id pull requests name people by.
pub fn map_viewer(v: &Value) -> Option<String> {
    string_at(v, "/authenticatedUser/id")
}

/// A build's `status` and `result`, as a status and the raw name shown beside it.
pub fn map_build_status(status: &str, result: Option<&str>) -> (RunStatus, String) {
    match status {
        "notStarted" | "postponed" => (RunStatus::Queued, status.to_string()),
        "inProgress" | "cancelling" => (RunStatus::Running, status.to_string()),
        "completed" => {
            let mapped = match result {
                Some("succeeded") => RunStatus::Success,
                Some("partiallySucceeded" | "failed") => RunStatus::Failure,
                Some("canceled") => RunStatus::Cancelled,
                _ => RunStatus::Other,
            };
            (mapped, result.unwrap_or(status).to_string())
        }
        _ => (RunStatus::Other, status.to_string()),
    }
}

fn event_of(reason: &str) -> String {
    match reason {
        "individualCI" | "batchedCI" => "push".into(),
        "pullRequest" => "pull_request".into(),
        other => other.to_ascii_lowercase(),
    }
}

/// One build from the builds list. `project_web` is `https://dev.azure.com/{org}/{project}`.
pub fn map_run(v: &Value, project_web: &str) -> Option<Run> {
    let id = v.get("id").and_then(Value::as_u64)?;
    let (status, raw_status) =
        map_build_status(str_at(v, "/status").unwrap_or(""), str_at(v, "/result"));
    let trigger = v.get("triggerInfo").unwrap_or(&Value::Null);
    // A pull request build runs on `refs/pull/<n>/merge`; its trigger names the real branch.
    let branch = str_at(trigger, "/pr.sourceBranch")
        .or_else(|| str_at(v, "/sourceBranch"))
        .map(|b| short_ref(b).to_string());
    let title = str_at(trigger, "/ci.message")
        .and_then(first_line)
        .or_else(|| string_at(trigger, "/pr.title"))
        .or_else(|| string_at(v, "/buildNumber"))
        .unwrap_or_default();
    Some(Run {
        id: id.to_string(),
        number: Some(id),
        name: string_at(v, "/definition/name").unwrap_or_else(|| "Build".into()),
        title,
        branch,
        sha: string_at(v, "/sourceVersion"),
        event: str_at(v, "/reason").map(event_of),
        status,
        raw_status,
        actor: string_at(v, "/requestedFor/displayName"),
        created_at: string_at(v, "/queueTime").unwrap_or_default(),
        started_at: string_at(v, "/startTime"),
        finished_at: string_at(v, "/finishTime"),
        web_url: format!("{project_web}/_build/results?buildId={id}"),
    })
}

/// A timeline record's `state` and `result`.
pub fn map_record_status(state: Option<&str>, result: Option<&str>) -> RunStatus {
    match state {
        Some("pending") => RunStatus::Queued,
        Some("inProgress") => RunStatus::Running,
        Some("completed") => match result {
            Some("succeeded" | "succeededWithIssues") => RunStatus::Success,
            Some("failed") => RunStatus::Failure,
            Some("canceled") => RunStatus::Cancelled,
            Some("skipped") => RunStatus::Skipped,
            _ => RunStatus::Other,
        },
        _ => RunStatus::Other,
    }
}

fn record_status(r: &Value) -> RunStatus {
    map_record_status(str_at(r, "/state"), str_at(r, "/result"))
}

fn order_of(r: &Value) -> i64 {
    r.get("order").and_then(Value::as_i64).unwrap_or(i64::MAX)
}

/// The timeline's Job records as jobs, each with its Task records as steps. The timeline is
/// unordered and flat (stage, phase, job, task by `parentId`), so jobs sort by the `order` of
/// each ancestor from the stage down, and a job in a named stage carries the stage's name.
pub fn map_timeline(timeline: &Value, run_web: &str) -> Vec<Job> {
    let records: Vec<&Value> = timeline
        .get("records")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let by_id: HashMap<&str, &Value> = records
        .iter()
        .filter_map(|r| Some((str_at(r, "/id")?, *r)))
        .collect();
    let ancestry = |r: &Value| -> Vec<&Value> {
        let mut chain = vec![];
        let mut at = str_at(r, "/parentId");
        // Bounded, in case a malformed timeline loops.
        while let Some(p) = at.and_then(|id| by_id.get(id)).filter(|_| chain.len() < 8) {
            chain.push(*p);
            at = str_at(p, "/parentId");
        }
        chain.reverse();
        chain
    };
    let stage_of = |r: &Value| {
        ancestry(r)
            .into_iter()
            .find(|a| str_at(a, "/type") == Some("Stage"))
            .and_then(|s| str_at(s, "/id"))
    };
    let held: Vec<&str> = records
        .iter()
        .filter(|r| is_open_approval(r))
        .filter_map(|r| stage_of(r))
        .collect();
    let mut jobs: Vec<(Vec<i64>, Job)> = records
        .iter()
        .filter(|r| str_at(r, "/type") == Some("Job"))
        .filter_map(|r| {
            let id = str_at(r, "/id")?;
            let chain = ancestry(r);
            let mut key: Vec<i64> = chain.iter().map(|a| order_of(a)).collect();
            key.push(order_of(r));
            let name = string_at(r, "/name").unwrap_or_else(|| "Job".into());
            // An implicit stage is named `__default`.
            let stage = chain
                .iter()
                .find(|a| str_at(a, "/type") == Some("Stage"))
                .and_then(|s| str_at(s, "/name"))
                .filter(|s| !s.starts_with("__") && *s != name);
            let mut tasks: Vec<&Value> = records
                .iter()
                .copied()
                .filter(|t| {
                    str_at(t, "/type") == Some("Task") && str_at(t, "/parentId") == Some(id)
                })
                .collect();
            tasks.sort_by_key(|t| order_of(t));
            let steps = tasks
                .iter()
                .enumerate()
                .map(|(i, t)| Step {
                    number: i as u32 + 1,
                    name: string_at(t, "/name").unwrap_or_default(),
                    status: record_status(t),
                })
                .collect();
            Some((
                key,
                Job {
                    id: id.to_string(),
                    name: match stage {
                        Some(s) => format!("{s} / {name}"),
                        None => name,
                    },
                    status: match record_status(r) {
                        RunStatus::Queued if stage_of(r).is_some_and(|s| held.contains(&s)) => {
                            RunStatus::Waiting
                        }
                        status => status,
                    },
                    started_at: string_at(r, "/startTime"),
                    finished_at: string_at(r, "/finishTime"),
                    web_url: Some(format!("{run_web}&view=logs&j={}", percent_encode(id))),
                    steps,
                },
            ))
        })
        .collect();
    jobs.sort_by(|a, b| a.0.cmp(&b.0));
    jobs.into_iter().map(|(_, j)| j).collect()
}

fn is_open_approval(r: &Value) -> bool {
    str_at(r, "/type") == Some("Checkpoint.Approval") && str_at(r, "/state") == Some("inProgress")
}

/// Whether an in-progress build is held at a stage approval with no job running. The build's own
/// status stays `inProgress` for as long as the approval waits, which can be weeks.
pub fn awaiting_approval(timeline: &Value) -> bool {
    let records = || {
        timeline
            .get("records")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
    };
    records().any(is_open_approval)
        && !records()
            .any(|r| str_at(r, "/type") == Some("Job") && str_at(r, "/state") == Some("inProgress"))
}

/// The log id of a timeline record, which the log endpoint takes instead of the record's id.
pub fn log_id_of(timeline: &Value, record_id: &str) -> Option<u64> {
    timeline
        .get("records")?
        .as_array()?
        .iter()
        .find(|r| str_at(r, "/id") == Some(record_id))?
        .pointer("/log/id")?
        .as_u64()
}

/// A reviewer's `vote`: 10 approved, 5 approved with suggestions, -5 waiting for the author,
/// -10 rejected, 0 no vote.
pub fn vote_state(vote: i64) -> ReviewState {
    match vote {
        v if v > 0 => ReviewState::Approved,
        v if v < 0 => ReviewState::ChangesRequested,
        _ => ReviewState::Pending,
    }
}

/// One pull request. `repo_web` is the repo's `_git` page.
pub fn map_pull(
    v: &Value,
    viewer: Option<&str>,
    repo_web: &str,
    checks: Option<RunStatus>,
) -> Option<PullRequest> {
    let number = v.get("pullRequestId").and_then(Value::as_u64)?;
    // Someone who declined to review is no longer asked.
    let listed: Vec<(&Value, ReviewState)> = v
        .get("reviewers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|r| r.get("hasDeclined").and_then(Value::as_bool) != Some(true))
        .map(|r| {
            let vote = r.get("vote").and_then(Value::as_i64).unwrap_or(0);
            (r, vote_state(vote))
        })
        .collect();
    let reviewers: Vec<Reviewer> = listed
        .iter()
        .map(|(r, state)| Reviewer {
            login: string_at(r, "/displayName").unwrap_or_default(),
            state: *state,
        })
        .collect();
    let any = |s: ReviewState| reviewers.iter().any(|r| r.state == s);
    let review_decision = if any(ReviewState::ChangesRequested) {
        Some(ReviewState::ChangesRequested)
    } else if any(ReviewState::Approved) {
        Some(ReviewState::Approved)
    } else if reviewers.is_empty() {
        None
    } else {
        Some(ReviewState::Pending)
    };
    let is_mine = viewer.is_some_and(|me| str_at(v, "/createdBy/id") == Some(me));
    let review_requested = viewer.is_some_and(|me| {
        listed
            .iter()
            .any(|(r, state)| str_at(r, "/id") == Some(me) && *state == ReviewState::Pending)
    });
    let state = match str_at(v, "/status") {
        Some("completed") => PullState::Merged,
        Some("abandoned") => PullState::Closed,
        _ => PullState::Open,
    };
    let created = string_at(v, "/creationDate").unwrap_or_default();
    Some(PullRequest {
        id: number.to_string(),
        number,
        title: string_at(v, "/title").unwrap_or_default(),
        author: string_at(v, "/createdBy/displayName").unwrap_or_default(),
        draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        state,
        source_branch: str_at(v, "/sourceRefName")
            .map(short_ref)
            .unwrap_or_default()
            .to_string(),
        target_branch: str_at(v, "/targetRefName")
            .map(short_ref)
            .unwrap_or_default()
            .to_string(),
        // The list carries no last-updated time; a closed one has its closing time.
        updated_at: string_at(v, "/closedDate").unwrap_or_else(|| created.clone()),
        created_at: created,
        web_url: format!("{repo_web}/pullrequest/{number}"),
        review_decision,
        reviewers,
        checks,
        checks_pending: false,
        is_mine,
        review_requested,
    })
}

/// The worst of a pull request's enabled build and status policy evaluations, or `None` when
/// it has none that apply.
pub fn policy_rollup(evaluations: &Value) -> Option<RunStatus> {
    let states: Vec<&str> = evaluations
        .get("value")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| {
            matches!(
                str_at(e, "/configuration/type/id"),
                Some(BUILD_POLICY | STATUS_POLICY)
            ) && e
                .pointer("/configuration/isEnabled")
                .and_then(Value::as_bool)
                != Some(false)
        })
        .filter_map(|e| str_at(e, "/status"))
        .filter(|s| *s != "notApplicable")
        .collect();
    if states.is_empty() {
        return None;
    }
    let any = |s: &str| states.contains(&s);
    Some(if any("rejected") || any("broken") {
        RunStatus::Failure
    } else if any("running") {
        RunStatus::Running
    } else if any("queued") {
        RunStatus::Queued
    } else if states.iter().all(|s| *s == "approved") {
        RunStatus::Success
    } else {
        RunStatus::Other
    })
}

/// A rollup that won't change while the source commit doesn't.
fn settled(checks: Option<RunStatus>) -> bool {
    !matches!(checks, Some(RunStatus::Queued | RunStatus::Running))
}

/// Cancel and re-run need Build (Read & execute); a 403 says which scope to add.
fn execute_error(e: ForgeError) -> ForgeError {
    match e.kind {
        ForgeErrorKind::Forbidden => missing_scope(SCOPE_BUILD_EXECUTE),
        _ => e,
    }
}

/// Azure DevOps answers a token that lacks a Build scope with a 401 on the builds endpoints
/// while its repo and pull request reads succeed, so a `signedOut` there names the scope once
/// the same token is known to read the repo.
fn build_error(e: ForgeError, scope: &str, reads_repo: impl FnOnce() -> bool) -> ForgeError {
    if e.kind == ForgeErrorKind::SignedOut && reads_repo() {
        missing_scope(scope)
    } else {
        e
    }
}

fn token_key(cx: &Cx) -> u64 {
    let mut h = DefaultHasher::new();
    cx.token.value.hash(&mut h);
    h.finish()
}

fn get(cx: &Cx, url: &str) -> Result<Value, ForgeError> {
    cx.http.get_json(url, Some(&auth_header(cx.token)), HEADERS)
}

/// A log body as text: a JSON `{"count", "value": [lines]}` reply, should the host send one
/// despite the plain text request, becomes its lines joined. Anything else, including a tail cut
/// from such a reply, passes through unchanged.
pub fn log_text(body: String) -> String {
    if !body.trim_start().starts_with('{') {
        return body;
    }
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return body;
    };
    let (Some(_), Some(lines)) = (
        v.get("count").and_then(Value::as_u64),
        v.get("value").and_then(Value::as_array),
    ) else {
        return body;
    };
    let mut text = lines
        .iter()
        .map(|l| l.as_str().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    text
}

/// A log's last `LOG_MAX` bytes; a log not written yet reads as empty.
fn fetch_log(cx: &Cx, url: &str) -> Result<JobLog, ForgeError> {
    match cx
        .http
        .get_text_tail(url, Some(&auth_header(cx.token)), LOG_HEADERS, LOG_MAX)
    {
        Ok((text, truncated)) => Ok(JobLog {
            text: log_text(text),
            truncated,
        }),
        Err(e) if e.kind == ForgeErrorKind::NotFound => Ok(JobLog {
            text: String::new(),
            truncated: false,
        }),
        Err(e) => Err(e),
    }
}

fn send(cx: &Cx, req: &Request) -> Result<(), ForgeError> {
    let auth = auth_header(cx.token);
    match req.method {
        "PATCH" => cx
            .http
            .patch_json(&req.url, Some(&auth), HEADERS, &req.body),
        _ => cx
            .http
            .post_json(&req.url, Some(&auth), HEADERS, Some(&req.body)),
    }
    .map(|_| ())
    .map_err(execute_error)
}

fn note_repo_reader(cx: &Cx, repo: &RepoRef) {
    let mut readers = REPO_READERS.lock_or_recover();
    if readers.len() >= CACHE_MAX {
        readers.clear();
    }
    readers.insert((token_key(cx), repo_key(repo)));
}

impl AzureDevOps {
    fn repo_info(&self, cx: &Cx, repo: &RepoRef) -> Result<RepoInfo, ForgeError> {
        let [org, proj, name] = segments(repo)?;
        let key = (
            repo.path[0].to_lowercase(),
            repo.path[1].to_lowercase(),
            repo.path[2].to_lowercase(),
        );
        if let Some(info) = REPOS.lock_or_recover().get(&key) {
            return Ok(info.clone());
        }
        let v = get(cx, &repo_url(&org, &proj, &name))?;
        let info = map_repo(&v)
            .ok_or_else(|| ForgeError::other("Azure DevOps did not describe this repo."))?;
        note_repo_reader(cx, repo);
        REPOS.lock_or_recover().insert(key, info.clone());
        Ok(info)
    }

    /// Whether this call's token reads the repo: known from an earlier lookup with the same
    /// token, or asked now with one GET.
    fn token_reads_repo(&self, cx: &Cx, repo: &RepoRef) -> bool {
        let entry = (token_key(cx), repo_key(repo));
        if REPO_READERS.lock_or_recover().contains(&entry) {
            return true;
        }
        let Ok([org, proj, name]) = segments(repo) else {
            return false;
        };
        let ok = get(cx, &repo_url(&org, &proj, &name)).is_ok();
        if ok {
            note_repo_reader(cx, repo);
        }
        ok
    }

    fn build_error(&self, cx: &Cx, repo: &RepoRef, scope: &str, e: ForgeError) -> ForgeError {
        build_error(e, scope, || self.token_reads_repo(cx, repo))
    }

    /// The viewer's identity id, which marks the pull requests that are theirs or await their
    /// vote. Only a success is cached, so a token replaced after a failure is asked again.
    fn viewer(&self, cx: &Cx, repo: &RepoRef) -> Result<Option<String>, ForgeError> {
        let [org, ..] = segments(repo)?;
        let key = (token_key(cx), org.to_lowercase());
        if let Some(v) = VIEWERS.lock_or_recover().get(&key) {
            return Ok(v.clone());
        }
        let id = map_viewer(&get(cx, &connection_url(&org))?);
        VIEWERS.lock_or_recover().insert(key, id.clone());
        Ok(id)
    }
}

impl ForgeProvider for AzureDevOps {
    fn kind(&self) -> ProviderKind {
        ProviderKind::AzureDevOps
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // Azure DevOps re-runs a build's failed stages only.
            rerun: false,
            rerun_failed: true,
            cancel: true,
            job_logs: true,
            drafts: true,
            pr_noun: "pull request".into(),
            run_noun: "build".into(),
            min_poll_secs: 20,
            accounts: false,
        }
    }

    fn runs(&self, cx: &Cx, repo: &RepoRef, branch: Option<&str>) -> Result<Vec<Run>, ForgeError> {
        let [org, proj, _] = segments(repo)?;
        let info = self.repo_info(cx, repo)?;
        let page = get(cx, &builds_url(&org, &proj, &info.id, branch))
            .map_err(|e| self.build_error(cx, repo, SCOPE_BUILD_READ, e))?;
        let web = project_base(&org, &proj);
        let mut runs: Vec<Run> = page
            .get("value")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| map_run(v, &web))
            .collect();
        // Only the timeline shows an approval hold. A failed timeline read leaves the run as
        // running rather than failing the whole list.
        for run in runs.iter_mut().filter(|r| r.raw_status == "inProgress") {
            let Ok(id) = build_id(&run.id) else { continue };
            if get(cx, &timeline_url(&org, &proj, id)).is_ok_and(|t| awaiting_approval(&t)) {
                run.status = RunStatus::Waiting;
            }
        }
        Ok(runs)
    }

    fn jobs(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<Vec<Job>, ForgeError> {
        let [org, proj, _] = segments(repo)?;
        let id = build_id(run_id)?;
        let timeline = get(cx, &timeline_url(&org, &proj, id))
            .map_err(|e| self.build_error(cx, repo, SCOPE_BUILD_READ, e))?;
        let run_web = format!("{}/_build/results?buildId={id}", project_base(&org, &proj));
        Ok(map_timeline(&timeline, &run_web))
    }

    fn log(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        run_id: &str,
        job_id: &str,
    ) -> Result<JobLog, ForgeError> {
        let [org, proj, _] = segments(repo)?;
        let id = build_id(run_id)?;
        // The job list carries record ids; the log endpoint wants the record's log id, which
        // appears only once the job has started.
        let timeline = get(cx, &timeline_url(&org, &proj, id))
            .map_err(|e| self.build_error(cx, repo, SCOPE_BUILD_READ, e))?;
        match log_id_of(&timeline, job_id) {
            Some(log_id) => fetch_log(cx, &log_url(&org, &proj, id, log_id))
                .map_err(|e| self.build_error(cx, repo, SCOPE_BUILD_READ, e)),
            None => Ok(JobLog {
                text: String::new(),
                truncated: false,
            }),
        }
    }

    fn rerun(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        run_id: &str,
        failed_only: bool,
    ) -> Result<(), ForgeError> {
        if !failed_only {
            return Err(ForgeError::other(
                "Azure DevOps re-runs a build's failed stages only.",
            ));
        }
        let [org, proj, _] = segments(repo)?;
        send(cx, &retry_request(&org, &proj, build_id(run_id)?))
            .map_err(|e| self.build_error(cx, repo, SCOPE_BUILD_EXECUTE, e))
    }

    fn cancel(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<(), ForgeError> {
        let [org, proj, _] = segments(repo)?;
        send(cx, &cancel_request(&org, &proj, build_id(run_id)?))
            .map_err(|e| self.build_error(cx, repo, SCOPE_BUILD_EXECUTE, e))
    }

    fn pulls(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        open_only: bool,
        branch: Option<&str>,
    ) -> Result<PullList, ForgeError> {
        let [org, proj, _] = segments(repo)?;
        let info = self.repo_info(cx, repo)?;
        let page = get(cx, &pulls_url(&org, &proj, &info.id, open_only, branch))?;
        let values: Vec<Value> = page
            .get("value")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let viewer = self.viewer(cx, repo)?;
        let key = repo_key(repo);
        let checks = CHECKS.lock_or_recover();
        let mut sources = SOURCES.lock_or_recover();
        if sources.len() >= CACHE_MAX {
            sources.clear();
        }
        let items = values
            .iter()
            .filter_map(|v| {
                let mut pull = map_pull(v, viewer.as_deref(), &repo.web_url, None)?;
                if pull.state != PullState::Open {
                    return Some(pull);
                }
                let commit = str_at(v, "/lastMergeSourceCommit/commitId").unwrap_or_default();
                sources.insert((key.clone(), pull.number), commit.to_string());
                match checks.get(&(key.clone(), pull.number)) {
                    Some((at, c)) if at == commit && settled(*c) => pull.checks = *c,
                    _ => pull.checks_pending = true,
                }
                Some(pull)
            })
            .collect();
        // `count` is this page's size, which is the total only when the page isn't full.
        let total = (values.len() < PULLS_TOP).then_some(values.len() as u64);
        Ok(PullList { items, total })
    }

    fn pull_checks(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        pulls: &[PullChecksQuery],
    ) -> Result<Vec<PullChecks>, ForgeError> {
        let [org, proj, _] = segments(repo)?;
        let info = self.repo_info(cx, repo)?;
        let key = repo_key(repo);
        let mut out = Vec::with_capacity(pulls.len());
        // In series: Azure DevOps throttles by load per user, and a poll rarely has many.
        for q in pulls {
            let Ok(id) = q.id.parse::<u64>() else {
                continue;
            };
            let Ok(v) = get(cx, &policy_url(&org, &proj, &info.project_id, id)) else {
                continue;
            };
            let checks = policy_rollup(&v);
            let commit = SOURCES.lock_or_recover().get(&(key.clone(), id)).cloned();
            if let Some(commit) = commit {
                let mut cache = CHECKS.lock_or_recover();
                if cache.len() >= CACHE_MAX {
                    cache.clear();
                }
                cache.insert((key.clone(), id), (commit, checks));
            }
            out.push(PullChecks {
                id: q.id.clone(),
                checks,
            });
        }
        Ok(out)
    }

    fn default_branch(&self, cx: &Cx, repo: &RepoRef) -> Result<Option<String>, ForgeError> {
        Ok(self.repo_info(cx, repo)?.default_branch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::http::{Http, map_status_at};

    fn token(value: &str, source: TokenSource) -> Token {
        Token {
            value: value.into(),
            source,
            expires: None,
        }
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b":fake-pat"), "OmZha2UtcGF0");
    }

    #[test]
    fn header_scheme_by_source() {
        let pat = "fake-pat";
        let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
        let stored = TokenSource::CredentialManager {
            target: "bashboard:dev.azure.com/contoso".into(),
        };
        let env = TokenSource::Env {
            var: "AZURE_DEVOPS_EXT_PAT".into(),
        };
        let gcm = TokenSource::GitCredential {
            host: "dev.azure.com".into(),
            username: None,
            path: Some("contoso".into()),
        };
        assert_eq!(auth_header(&token(pat, stored)), "Basic OmZha2UtcGF0");
        assert_eq!(auth_header(&token(pat, env)), "Basic OmZha2UtcGF0");
        assert_eq!(
            auth_header(&token(jwt, TokenSource::AzCli)),
            format!("Bearer {jwt}")
        );
        assert_eq!(
            auth_header(&token(jwt, gcm.clone())),
            format!("Bearer {jwt}")
        );
        assert_eq!(auth_header(&token(pat, gcm.clone())), "Basic OmZha2UtcGF0");
        // Dots alone don't make a JWT.
        assert!(auth_header(&token("a.b.c", gcm)).starts_with("Basic "));
    }

    #[test]
    fn capabilities_and_scope_errors() {
        let c = AzureDevOps.capabilities();
        assert!(!c.rerun && c.rerun_failed && c.cancel && c.job_logs && c.drafts && !c.accounts);
        assert_eq!(
            (c.pr_noun.as_str(), c.run_noun.as_str(), c.min_poll_secs),
            ("pull request", "build", 20)
        );
        assert_eq!(
            missing_scope(SCOPE_BUILD_EXECUTE).message,
            "This token is missing the Build (Read & execute) scope."
        );
        let e = execute_error(map_status_at(403, &[], 0).unwrap());
        assert_eq!(e.kind, ForgeErrorKind::Forbidden);
        assert!(e.message.contains("Build (Read & execute)"));
        let signed_out = map_status_at(401, &[], 0).unwrap();
        assert_eq!(execute_error(signed_out.clone()), signed_out);
    }

    #[test]
    fn a_build_401_names_the_scope_only_for_a_token_that_reads_the_repo() {
        let signed_out = map_status_at(401, &[], 0).unwrap();
        let e = build_error(signed_out.clone(), SCOPE_BUILD_READ, || true);
        assert_eq!(e.kind, ForgeErrorKind::Forbidden);
        assert_eq!(e.message, "This token is missing the Build (Read) scope.");
        let e = build_error(signed_out.clone(), SCOPE_BUILD_EXECUTE, || true);
        assert_eq!(e.kind, ForgeErrorKind::Forbidden);
        assert!(e.message.contains("Build (Read & execute)"));
        // A token that can't read the repo either is a bad sign-in.
        assert_eq!(
            build_error(signed_out.clone(), SCOPE_BUILD_READ, || false),
            signed_out
        );
        // Other failures pass through without asking about the repo.
        let not_found = map_status_at(404, &[], 0).unwrap();
        assert_eq!(
            build_error(not_found.clone(), SCOPE_BUILD_READ, || panic!("asked")),
            not_found
        );
    }

    fn repo_ref(path: &[&str]) -> RepoRef {
        RepoRef {
            provider: ProviderKind::AzureDevOps,
            host: "dev.azure.com".into(),
            path: path.iter().map(|s| s.to_string()).collect(),
            web_url: format!("https://dev.azure.com/{}", path.join("/")),
        }
    }

    #[test]
    fn urls_encode_each_segment_and_carry_the_version() {
        let [org, proj, name] = segments(&repo_ref(&["contoso", "My Proj", "re po"])).unwrap();
        assert_eq!((org.as_str(), proj.as_str()), ("contoso", "My%20Proj"));
        assert_eq!(
            repo_url(&org, &proj, &name),
            "https://dev.azure.com/contoso/My%20Proj/_apis/git/repositories/re%20po?api-version=7.1"
        );
        assert_eq!(
            connection_url("contoso"),
            "https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1-preview"
        );
        assert!(segments(&repo_ref(&["contoso", "Proj"])).is_err());
        assert_eq!(
            timeline_url("contoso", "Proj", 42),
            "https://dev.azure.com/contoso/Proj/_apis/build/builds/42/timeline?api-version=7.1"
        );
        assert_eq!(
            log_url("contoso", "Proj", 42, 14),
            "https://dev.azure.com/contoso/Proj/_apis/build/builds/42/logs/14?api-version=7.1"
        );
        assert_eq!(
            policy_url("contoso", "Proj", "p-guid", 7),
            "https://dev.azure.com/contoso/Proj/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fp-guid%2F7&api-version=7.1-preview"
        );
        assert!(build_id("12").is_ok());
        assert!(build_id("12/../x").is_err());
    }

    #[test]
    fn branch_filters_go_in_the_query_only_when_asked() {
        assert_eq!(
            builds_url("contoso", "Proj", "r-id", None),
            "https://dev.azure.com/contoso/Proj/_apis/build/builds?repositoryId=r-id&repositoryType=TfsGit&$top=20&api-version=7.1"
        );
        assert_eq!(
            builds_url("contoso", "Proj", "r-id", Some("feat/a b")),
            "https://dev.azure.com/contoso/Proj/_apis/build/builds?repositoryId=r-id&repositoryType=TfsGit&branchName=refs%2Fheads%2Ffeat%2Fa%20b&$top=20&api-version=7.1"
        );
        assert_eq!(
            pulls_url("contoso", "Proj", "r-id", true, None),
            "https://dev.azure.com/contoso/Proj/_apis/git/repositories/r-id/pullrequests?searchCriteria.status=active&$top=50&api-version=7.1"
        );
        assert_eq!(
            pulls_url("contoso", "Proj", "r-id", false, Some("feat/x")),
            "https://dev.azure.com/contoso/Proj/_apis/git/repositories/r-id/pullrequests?searchCriteria.status=all&searchCriteria.sourceRefName=refs%2Fheads%2Ffeat%2Fx&$top=50&api-version=7.1"
        );
    }

    #[test]
    fn cancel_and_retry_requests() {
        assert_eq!(
            cancel_request("contoso", "My%20Proj", 42),
            Request {
                method: "PATCH",
                url:
                    "https://dev.azure.com/contoso/My%20Proj/_apis/build/builds/42?api-version=7.1"
                        .into(),
                body: json!({ "status": "cancelling" }),
            }
        );
        assert_eq!(
            retry_request("contoso", "Proj", 42),
            Request {
                method: "PATCH",
                url: "https://dev.azure.com/contoso/Proj/_apis/build/builds/42?retry=true&api-version=7.1"
                    .into(),
                body: json!({}),
            }
        );
    }

    #[test]
    fn rerun_of_the_whole_build_is_refused_before_any_request() {
        let http = Http::default();
        let t = token("fake-pat", TokenSource::AzCli);
        let cx = Cx {
            http: &http,
            token: &t,
        };
        let repo = repo_ref(&["contoso", "Proj", "repo"]);
        let e = AzureDevOps.rerun(&cx, &repo, "42", false).unwrap_err();
        assert!(e.message.contains("failed stages only"));
        // A non-numeric id is refused before any request too.
        assert!(AzureDevOps.cancel(&cx, &repo, "42/x").is_err());
    }

    #[test]
    fn every_build_status_and_result() {
        use RunStatus as S;
        let table = [
            ("notStarted", None, S::Queued, "notStarted"),
            ("postponed", None, S::Queued, "postponed"),
            ("inProgress", None, S::Running, "inProgress"),
            ("cancelling", None, S::Running, "cancelling"),
            ("completed", Some("succeeded"), S::Success, "succeeded"),
            (
                "completed",
                Some("partiallySucceeded"),
                S::Failure,
                "partiallySucceeded",
            ),
            ("completed", Some("failed"), S::Failure, "failed"),
            ("completed", Some("canceled"), S::Cancelled, "canceled"),
            ("completed", Some("none"), S::Other, "none"),
            ("completed", None, S::Other, "completed"),
            ("somethingNew", None, S::Other, "somethingNew"),
        ];
        for (status, result, want, raw) in table {
            assert_eq!(
                map_build_status(status, result),
                (want, raw.to_string()),
                "{status} {result:?}"
            );
        }
    }

    /// A build as the builds list returns it, trimmed and with names and ids replaced.
    fn build() -> Value {
        serde_json::from_str(
            r#"{
                "id": 1201,
                "buildNumber": "20261001.3",
                "status": "completed",
                "result": "succeeded",
                "queueTime": "2026-10-01T01:29:10.5545506Z",
                "startTime": "2026-10-01T01:33:51.6154421Z",
                "finishTime": "2026-10-01T01:36:47.6779065Z",
                "sourceBranch": "refs/heads/main",
                "sourceVersion": "8817703f79407be85da15a4ee43c3e8ad8a287cb",
                "reason": "individualCI",
                "definition": { "id": 9, "name": "repo-Database" },
                "requestedFor": { "displayName": "Pat Doe", "id": "00000000-0000-0000-0000-000000000001" },
                "triggerInfo": {
                    "ci.sourceBranch": "refs/heads/main",
                    "ci.sourceSha": "8817703f79407be85da15a4ee43c3e8ad8a287cb",
                    "ci.message": "Merged PR 12: Add an error log\n\nDetails",
                    "ci.triggerRepository": "11111111-1111-1111-1111-111111111111"
                },
                "_links": { "web": { "href": "https://dev.azure.com/contoso/p-guid/_build/results?buildId=1201" } }
            }"#,
        )
        .unwrap()
    }

    const PROJECT_WEB: &str = "https://dev.azure.com/contoso/Proj";

    #[test]
    fn a_build_maps_to_a_run() {
        let r = map_run(&build(), PROJECT_WEB).unwrap();
        assert_eq!((r.id.as_str(), r.number), ("1201", Some(1201)));
        assert_eq!(r.name, "repo-Database");
        assert_eq!(r.title, "Merged PR 12: Add an error log");
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(
            r.sha.as_deref(),
            Some("8817703f79407be85da15a4ee43c3e8ad8a287cb")
        );
        assert_eq!(r.event.as_deref(), Some("push"));
        assert_eq!(
            (r.status, r.raw_status.as_str()),
            (RunStatus::Success, "succeeded")
        );
        assert_eq!(r.actor.as_deref(), Some("Pat Doe"));
        assert_eq!(r.created_at, "2026-10-01T01:29:10.5545506Z");
        assert_eq!(
            r.started_at.as_deref(),
            Some("2026-10-01T01:33:51.6154421Z")
        );
        assert_eq!(
            r.finished_at.as_deref(),
            Some("2026-10-01T01:36:47.6779065Z")
        );
        assert_eq!(
            r.web_url,
            "https://dev.azure.com/contoso/Proj/_build/results?buildId=1201"
        );

        // A manual build waiting for an agent, with no trigger message.
        let v = json!({
            "id": 7, "buildNumber": "20261002.1", "status": "notStarted",
            "sourceBranch": "refs/heads/dev", "reason": "manual", "queueTime": "q"
        });
        let r = map_run(&v, PROJECT_WEB).unwrap();
        assert_eq!((r.name.as_str(), r.title.as_str()), ("Build", "20261002.1"));
        assert_eq!(
            (r.status, r.event.as_deref()),
            (RunStatus::Queued, Some("manual"))
        );
        assert_eq!((r.started_at, r.finished_at, r.actor), (None, None, None));

        // A pull request build names its source branch, not the merge ref.
        let v = json!({
            "id": 8, "status": "inProgress", "reason": "pullRequest",
            "sourceBranch": "refs/pull/12/merge",
            "triggerInfo": { "pr.sourceBranch": "refs/heads/feature/x", "pr.title": "Add x" }
        });
        let r = map_run(&v, PROJECT_WEB).unwrap();
        assert_eq!(r.branch.as_deref(), Some("feature/x"));
        assert_eq!(
            (r.title.as_str(), r.event.as_deref()),
            ("Add x", Some("pull_request"))
        );
        assert!(map_run(&json!({ "status": "completed" }), PROJECT_WEB).is_none());
    }

    /// A multi-stage build's timeline, trimmed: two stages, an implicit-free job tree, and a
    /// job still waiting behind an approval.
    fn timeline() -> Value {
        serde_json::from_str(
            r#"{ "records": [
                { "id": "t-dl", "parentId": "j-apply", "type": "Task", "name": "Download", "state": "completed", "result": "succeeded", "order": 2, "log": { "id": 16 } },
                { "id": "s-prod", "parentId": null, "type": "Stage", "name": "Apply to production", "state": "pending", "result": null, "order": 3 },
                { "id": "s-script", "parentId": null, "type": "Stage", "name": "Script migrations", "state": "completed", "result": "succeeded", "order": 1 },
                { "id": "j-gen", "parentId": "p-gen", "type": "Job", "name": "Generate script", "state": "completed", "result": "failed", "order": 1, "startTime": "a", "finishTime": "b", "log": { "id": 14 } },
                { "id": "t-pub", "parentId": "j-gen", "type": "Task", "name": "Publish script", "state": "completed", "result": "skipped", "order": 8, "log": { "id": 11 } },
                { "id": "s-dev", "parentId": null, "type": "Stage", "name": "Apply to development", "state": "completed", "result": "succeeded", "order": 2 },
                { "id": "j-apply", "parentId": "p-apply", "type": "Job", "name": "Apply script", "state": "inProgress", "result": null, "startTime": "c", "log": { "id": 19 } },
                { "id": "t-verify", "parentId": "j-gen", "type": "Task", "name": "Verify script", "state": "completed", "result": "failed", "order": 7, "log": { "id": 10 } },
                { "id": "c-approve", "parentId": "s-prod", "type": "Checkpoint.Approval", "name": "Checkpoint.Approval", "state": "inProgress" },
                { "id": "t-init", "parentId": "j-gen", "type": "Task", "name": "Initialize job", "state": "completed", "result": "succeeded", "order": 1, "log": { "id": 4 } },
                { "id": "j-prod", "parentId": "p-prod", "type": "Job", "name": "Apply script (production)", "state": "pending", "result": null, "order": 1 },
                { "id": "p-prod", "parentId": "s-prod", "type": "Phase", "name": "Apply script (production)", "state": "pending", "order": 1 },
                { "id": "p-apply", "parentId": "s-dev", "type": "Phase", "name": "Apply script", "state": "inProgress", "order": 1 },
                { "id": "p-gen", "parentId": "s-script", "type": "Phase", "name": "Generate script", "state": "completed", "result": "failed", "order": 1 },
                { "id": "t-final", "parentId": "j-gen", "type": "Task", "name": "Finalize Job", "state": "completed", "result": "succeededWithIssues", "order": 10, "log": { "id": 13 } },
                { "id": "j-final", "parentId": null, "type": "Job", "name": "Finalize build", "state": "completed", "result": "succeeded", "order": 2147483647 }
            ] }"#,
        )
        .unwrap()
    }

    /// A held build's timeline as Azure DevOps nests it: the approval under a Checkpoint under the
    /// gated stage, which has a pending Phase but no Job record yet.
    fn held_timeline(job_state: &str) -> Value {
        let result = (job_state == "completed").then_some("succeeded");
        json!({ "records": [
            { "id": "s-dev", "parentId": null, "type": "Stage", "name": "Apply to development", "state": "completed", "result": "succeeded", "order": 1 },
            { "id": "p-dev", "parentId": "s-dev", "type": "Phase", "name": "Apply", "state": "completed", "order": 1 },
            { "id": "j-dev", "parentId": "p-dev", "type": "Job", "name": "Apply", "state": job_state, "result": result, "order": 1 },
            { "id": "s-prod", "parentId": null, "type": "Stage", "name": "Apply to production", "state": "pending", "order": 2 },
            { "id": "c-prod", "parentId": "s-prod", "type": "Checkpoint", "name": "Checkpoint", "state": "inProgress" },
            { "id": "a-prod", "parentId": "c-prod", "type": "Checkpoint.Approval", "name": "Checkpoint.Approval", "state": "inProgress" },
            { "id": "p-prod", "parentId": "s-prod", "type": "Phase", "name": "Apply", "state": "pending", "order": 1 }
        ] })
    }

    #[test]
    fn an_open_approval_with_no_running_job_is_waiting() {
        assert!(awaiting_approval(&held_timeline("completed")));
        assert!(
            !awaiting_approval(&timeline()),
            "a job is still in progress"
        );
        assert!(!awaiting_approval(&held_timeline("inProgress")));
        let mut approved = held_timeline("completed");
        approved["records"][5]["state"] = json!("completed");
        assert!(!awaiting_approval(&approved));
        assert!(!awaiting_approval(&json!({})));
    }

    #[test]
    fn a_job_behind_a_nested_approval_is_waiting() {
        let mut t = held_timeline("completed");
        t["records"].as_array_mut().unwrap().push(json!(
            { "id": "j-prod", "parentId": "p-prod", "type": "Job", "name": "Apply", "state": "pending", "order": 1 }
        ));
        let statuses: Vec<RunStatus> = map_timeline(&t, "w").iter().map(|j| j.status).collect();
        assert_eq!(statuses, vec![RunStatus::Success, RunStatus::Waiting]);
    }

    #[test]
    fn a_timeline_maps_to_jobs_and_steps() {
        let run_web = format!("{PROJECT_WEB}/_build/results?buildId=1201");
        let jobs = map_timeline(&timeline(), &run_web);
        let got: Vec<(&str, &str, RunStatus)> = jobs
            .iter()
            .map(|j| (j.id.as_str(), j.name.as_str(), j.status))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "j-gen",
                    "Script migrations / Generate script",
                    RunStatus::Failure
                ),
                (
                    "j-apply",
                    "Apply to development / Apply script",
                    RunStatus::Running
                ),
                // Pending behind the production stage's open approval.
                (
                    "j-prod",
                    "Apply to production / Apply script (production)",
                    RunStatus::Waiting
                ),
                ("j-final", "Finalize build", RunStatus::Success),
            ]
        );
        let first = &jobs[0];
        assert_eq!(
            (first.started_at.as_deref(), first.finished_at.as_deref()),
            (Some("a"), Some("b"))
        );
        assert_eq!(
            first.web_url.as_deref(),
            Some(
                "https://dev.azure.com/contoso/Proj/_build/results?buildId=1201&view=logs&j=j-gen"
            )
        );
        let steps: Vec<(u32, &str, RunStatus)> = first
            .steps
            .iter()
            .map(|s| (s.number, s.name.as_str(), s.status))
            .collect();
        assert_eq!(
            steps,
            vec![
                (1, "Initialize job", RunStatus::Success),
                (2, "Verify script", RunStatus::Failure),
                (3, "Publish script", RunStatus::Skipped),
                (4, "Finalize Job", RunStatus::Success),
            ]
        );
        assert_eq!(jobs[1].steps.len(), 1);
        assert!(jobs[2].steps.is_empty() && jobs[3].steps.is_empty());
        assert!(map_timeline(&json!({}), &run_web).is_empty());

        assert_eq!(log_id_of(&timeline(), "j-gen"), Some(14));
        assert_eq!(log_id_of(&timeline(), "j-prod"), None);
        assert_eq!(log_id_of(&timeline(), "nope"), None);
    }

    #[test]
    fn record_states() {
        use RunStatus as S;
        let table = [
            (Some("pending"), None, S::Queued),
            (Some("inProgress"), None, S::Running),
            (Some("completed"), Some("succeeded"), S::Success),
            (Some("completed"), Some("succeededWithIssues"), S::Success),
            (Some("completed"), Some("failed"), S::Failure),
            (Some("completed"), Some("canceled"), S::Cancelled),
            (Some("completed"), Some("skipped"), S::Skipped),
            (Some("completed"), Some("abandoned"), S::Other),
            (None, None, S::Other),
        ];
        for (state, result, want) in table {
            assert_eq!(
                map_record_status(state, result),
                want,
                "{state:?} {result:?}"
            );
        }
    }

    #[test]
    fn votes() {
        assert_eq!(vote_state(10), ReviewState::Approved);
        assert_eq!(vote_state(5), ReviewState::Approved);
        assert_eq!(vote_state(0), ReviewState::Pending);
        assert_eq!(vote_state(-5), ReviewState::ChangesRequested);
        assert_eq!(vote_state(-10), ReviewState::ChangesRequested);
    }

    const REPO_WEB: &str = "https://dev.azure.com/contoso/Proj/_git/repo";
    const ME: &str = "00000000-0000-0000-0000-00000000000a";

    fn reviewer(id: &str, name: &str, vote: i64) -> Value {
        json!({ "id": id, "displayName": name, "vote": vote, "hasDeclined": false, "isFlagged": false })
    }

    /// A pull request as the list returns it, trimmed and with people and names replaced.
    fn pull(reviewers: Vec<Value>) -> Value {
        let mut v: Value = serde_json::from_str(
            r#"{
                "repository": { "id": "11111111-1111-1111-1111-111111111111", "name": "repo" },
                "pullRequestId": 12,
                "codeReviewId": 12,
                "status": "active",
                "createdBy": { "displayName": "Pat Doe", "id": "00000000-0000-0000-0000-00000000000a" },
                "creationDate": "2026-10-13T20:23:47.0886183Z",
                "title": "Close the connectors",
                "sourceRefName": "refs/heads/feature/docs",
                "targetRefName": "refs/heads/main",
                "mergeStatus": "succeeded",
                "isDraft": false,
                "lastMergeSourceCommit": { "commitId": "8df87c15031aefd1e22f720cf66324e96db43c3b" },
                "supportsIterations": true
            }"#,
        )
        .unwrap();
        v["reviewers"] = Value::Array(reviewers);
        v
    }

    #[test]
    fn a_pull_request_with_each_vote() {
        let v = pull(vec![
            reviewer("r-1", "Approver", 10),
            reviewer("r-2", "Suggester", 5),
            reviewer("r-3", "Waiter", -5),
            reviewer(ME, "Me", 0),
        ]);
        let pr = map_pull(&v, Some(ME), REPO_WEB, Some(RunStatus::Running)).unwrap();
        let got: Vec<(&str, ReviewState)> = pr
            .reviewers
            .iter()
            .map(|r| (r.login.as_str(), r.state))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Approver", ReviewState::Approved),
                ("Suggester", ReviewState::Approved),
                ("Waiter", ReviewState::ChangesRequested),
                ("Me", ReviewState::Pending),
            ]
        );
        assert_eq!(pr.review_decision, Some(ReviewState::ChangesRequested));
        assert!(pr.is_mine && pr.review_requested);
        assert_eq!(pr.checks, Some(RunStatus::Running));
        assert_eq!(
            (
                pr.id.as_str(),
                pr.number,
                pr.title.as_str(),
                pr.author.as_str()
            ),
            ("12", 12, "Close the connectors", "Pat Doe")
        );
        assert_eq!(
            (pr.source_branch.as_str(), pr.target_branch.as_str()),
            ("feature/docs", "main")
        );
        assert_eq!(pr.state, PullState::Open);
        assert_eq!(pr.updated_at, "2026-10-13T20:23:47.0886183Z");
        assert_eq!(
            pr.web_url,
            "https://dev.azure.com/contoso/Proj/_git/repo/pullrequest/12"
        );

        // Approved only; a reviewer who declined drops out, and a voter isn't asked again.
        let mut declined = reviewer("r-4", "Declined", -10);
        declined["hasDeclined"] = json!(true);
        let v = pull(vec![reviewer(ME, "Me", 10), declined]);
        let pr = map_pull(&v, Some("someone-else"), REPO_WEB, None).unwrap();
        assert_eq!(pr.review_decision, Some(ReviewState::Approved));
        assert_eq!(pr.reviewers.len(), 1);
        assert!(!pr.is_mine && !pr.review_requested);
        let pr = map_pull(&v, Some(ME), REPO_WEB, None).unwrap();
        assert!(!pr.review_requested);

        let v = pull(vec![reviewer("r-1", "W", 0)]);
        assert_eq!(
            map_pull(&v, None, REPO_WEB, None).unwrap().review_decision,
            Some(ReviewState::Pending)
        );
    }

    #[test]
    fn a_draft_and_closed_states() {
        let mut v = pull(vec![]);
        v["isDraft"] = json!(true);
        let pr = map_pull(&v, None, REPO_WEB, None).unwrap();
        assert!(pr.draft && !pr.is_mine && !pr.review_requested);
        assert_eq!((pr.review_decision, pr.reviewers.len()), (None, 0));
        for (status, want) in [
            ("active", PullState::Open),
            ("completed", PullState::Merged),
            ("abandoned", PullState::Closed),
        ] {
            let mut v = pull(vec![]);
            v["status"] = json!(status);
            v["closedDate"] = json!("2026-10-14T00:00:00Z");
            let pr = map_pull(&v, None, REPO_WEB, None).unwrap();
            assert_eq!(pr.state, want, "{status}");
            assert_eq!(pr.updated_at, "2026-10-14T00:00:00Z");
        }
        assert!(map_pull(&json!({ "title": "no id" }), None, REPO_WEB, None).is_none());
    }

    #[test]
    fn repo_and_viewer() {
        let v = json!({
            "id": "11111111-1111-1111-1111-111111111111",
            "name": "repo",
            "project": { "id": "22222222-2222-2222-2222-222222222222", "name": "Proj" },
            "defaultBranch": "refs/heads/main"
        });
        assert_eq!(
            map_repo(&v),
            Some(RepoInfo {
                id: "11111111-1111-1111-1111-111111111111".into(),
                project_id: "22222222-2222-2222-2222-222222222222".into(),
                default_branch: Some("main".into()),
            })
        );
        assert_eq!(map_repo(&json!({ "id": "x" })), None);
        let conn = json!({
            "authenticatedUser": { "id": ME, "providerDisplayName": "Pat Doe" },
            "authorizedUser": { "id": ME }
        });
        assert_eq!(map_viewer(&conn).as_deref(), Some(ME));
        assert_eq!(map_viewer(&json!({})), None);
    }

    fn evaluation(type_id: &str, status: &str, enabled: bool) -> Value {
        json!({
            "evaluationId": "e",
            "status": status,
            "configuration": { "isEnabled": enabled, "isBlocking": true, "type": { "id": type_id } }
        })
    }

    #[test]
    fn policy_evaluations_roll_up() {
        let reviewers = "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd";
        let roll = |e: Vec<Value>| policy_rollup(&json!({ "value": e, "count": 0 }));
        assert_eq!(policy_rollup(&json!({ "value": [], "count": 0 })), None);
        assert_eq!(roll(vec![evaluation(reviewers, "rejected", true)]), None);
        assert_eq!(
            roll(vec![evaluation(BUILD_POLICY, "notApplicable", true)]),
            None
        );
        assert_eq!(
            roll(vec![evaluation(BUILD_POLICY, "approved", true)]),
            Some(RunStatus::Success)
        );
        assert_eq!(
            roll(vec![
                evaluation(BUILD_POLICY, "approved", true),
                evaluation(STATUS_POLICY, "running", true),
            ]),
            Some(RunStatus::Running)
        );
        assert_eq!(
            roll(vec![
                evaluation(BUILD_POLICY, "queued", true),
                evaluation(BUILD_POLICY, "rejected", true),
            ]),
            Some(RunStatus::Failure)
        );
        assert_eq!(
            roll(vec![evaluation(BUILD_POLICY, "queued", true)]),
            Some(RunStatus::Queued)
        );
        assert_eq!(
            roll(vec![evaluation(BUILD_POLICY, "broken", true)]),
            Some(RunStatus::Failure)
        );
        assert_eq!(
            roll(vec![evaluation(BUILD_POLICY, "rejected", false)]),
            None
        );
        assert!(settled(None) && settled(Some(RunStatus::Failure)));
        assert!(!settled(Some(RunStatus::Queued)) && !settled(Some(RunStatus::Running)));
    }

    /// One reply from a loopback server, for the paths that only a real response exercises.
    fn serve_once(status: &str, content_type: &str, body: &str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x", listener.local_addr().unwrap());
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let _ = s.write_all(reply.as_bytes());
            }
        });
        url
    }

    #[test]
    fn a_sign_in_page_reads_as_signed_out() {
        let page = "<!DOCTYPE html><html><head><title>Sign in</title></head></html>";
        let http = Http::default();
        let t = token("fake-pat", TokenSource::Env { var: "X".into() });
        let cx = Cx {
            http: &http,
            token: &t,
        };
        let url = serve_once(
            "203 Non-Authoritative Information",
            "text/html; charset=utf-8",
            page,
        );
        let e = get(&cx, &url).unwrap_err();
        assert_eq!(e.kind, ForgeErrorKind::SignedOut);
        // The log download reads the body as text, so it needs the same check.
        let url = serve_once(
            "203 Non-Authoritative Information",
            "text/html; charset=utf-8",
            page,
        );
        let e = fetch_log(&cx, &url).unwrap_err();
        assert_eq!(e.kind, ForgeErrorKind::SignedOut);
        let url = serve_once(
            "200 OK",
            "text/plain; charset=utf-8",
            "<tag> in a log line\n",
        );
        let log = fetch_log(&cx, &url).unwrap();
        assert_eq!(log.text, "<tag> in a log line\n");
        let url = serve_once("404 Not Found", "application/json", "{}");
        assert_eq!(fetch_log(&cx, &url).unwrap().text, "");
    }

    #[test]
    fn the_log_download_asks_for_plain_text() {
        fn accept<'a>(h: &[(&str, &'a str)]) -> &'a str {
            h.iter().find(|(k, _)| *k == "Accept").unwrap().1
        }
        assert_eq!(accept(LOG_HEADERS), "text/plain");
        assert_eq!(accept(HEADERS), "application/json");
        assert!(LOG_HEADERS.contains(&("X-TFS-FedAuthRedirect", "Suppress")));
    }

    #[test]
    fn a_json_log_reply_becomes_its_lines() {
        let body = r#"{"count":2,"value":["2024-01-01T00:00:00Z step one","{\"not\": \"json\"}"]}"#;
        assert_eq!(
            log_text(body.into()),
            "2024-01-01T00:00:00Z step one\n{\"not\": \"json\"}\n"
        );
        assert_eq!(log_text(r#"{"count":0,"value":[]}"#.into()), "");
        // Plain text, a log line that is JSON, and a cut tail pass through.
        assert_eq!(
            log_text("line one\nline two\n".into()),
            "line one\nline two\n"
        );
        assert_eq!(log_text(r#"{"a": 1}"#.into()), r#"{"a": 1}"#);
        assert_eq!(
            log_text(r#"{"count":5,"value":["x"#.into()),
            r#"{"count":5,"value":["x"#
        );
    }

    /// Live and read-only: every call here is a GET. Set `BASHBOARD_ADO_LIVE` to
    /// `<org>/<project>/<repo>` and `AZURE_DEVOPS_EXT_PAT` to a PAT, then
    /// `cargo test forge::azure_devops -- --ignored`. Prints neither the token nor its length.
    #[test]
    #[ignore]
    fn live_reads() {
        let target = std::env::var("BASHBOARD_ADO_LIVE").expect("BASHBOARD_ADO_LIVE");
        let path: Vec<&str> = target.split('/').collect();
        let t = token(
            &std::env::var("AZURE_DEVOPS_EXT_PAT").expect("AZURE_DEVOPS_EXT_PAT"),
            TokenSource::Env {
                var: "AZURE_DEVOPS_EXT_PAT".into(),
            },
        );
        let http = Http::default();
        let cx = Cx {
            http: &http,
            token: &t,
        };
        let repo = repo_ref(&path);
        assert!(AzureDevOps.default_branch(&cx, &repo).unwrap().is_some());
        let runs = AzureDevOps.runs(&cx, &repo, None).unwrap();
        assert!(!runs.is_empty() && runs.len() <= RUNS_TOP);
        let done = runs
            .iter()
            .find(|r| r.finished_at.is_some())
            .expect("a finished build");
        let jobs = AzureDevOps.jobs(&cx, &repo, &done.id).unwrap();
        assert!(!jobs.is_empty());
        let log = AzureDevOps.log(&cx, &repo, &done.id, &jobs[0].id).unwrap();
        assert!(!log.text.is_empty());
        assert!(!log.text.starts_with("{\"count\""));
        let open = AzureDevOps.pulls(&cx, &repo, true, None).unwrap();
        let all = AzureDevOps.pulls(&cx, &repo, false, None).unwrap();
        let queries: Vec<PullChecksQuery> = open
            .items
            .iter()
            .chain(all.items.iter().take(3))
            .map(|p| PullChecksQuery {
                id: p.id.clone(),
                updated_at: p.updated_at.clone(),
            })
            .collect();
        let found = AzureDevOps.pull_checks(&cx, &repo, &queries).unwrap();
        eprintln!(
            "{} runs, {} jobs in the first finished one, log {} bytes, {} open and {} listed pull requests, {} of {} checks answered",
            runs.len(),
            jobs.len(),
            log.text.len(),
            open.items.len(),
            all.items.len(),
            found.len(),
            queries.len()
        );
    }
}
