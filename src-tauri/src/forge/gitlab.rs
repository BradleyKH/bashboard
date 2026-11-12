//! GitLab, gitlab.com and self-managed (docs/design/ship.md section 3.20), over the v4 REST API
//! with a Bearer token. The JSON-to-DTO mapping and the action requests are pure functions over
//! `serde_json::Value`, so they test without the network.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::thread;

use serde_json::{Value, json};

use super::remote::percent_encode;
use super::types::{
    Capabilities, ForgeError, ForgeErrorKind, Job, JobLog, ProviderKind, PullChecks,
    PullChecksQuery, PullList, PullRequest, PullState, RepoRef, ReviewState, Reviewer, Run,
    RunStatus,
};
use super::{Cx, ForgeProvider, MAX_PULLS, MAX_RUNS};
use crate::lock::LockExt;

const LOG_MAX: usize = 1024 * 1024;
const ACCEPT: &[(&str, &str)] = &[("Accept", "application/json")];
/// Concurrent detail requests while filling in pipelines or merge request checks.
const WORKERS: usize = 8;
/// Past this many entries a cache starts over rather than growing for the session.
const CACHE_MAX: usize = 2000;

/// The viewer's user id per (host, token hash), cached once `/user` answers.
static VIEWERS: LazyLock<Mutex<HashMap<(String, u64), u64>>> = LazyLock::new(Default::default);

/// The fields `map_run` reads from a pipeline's detail, by (project base, pipeline id), with the
/// list's `updated_at` they were fetched at. The list lacks the name, user, and times, and a
/// pipeline's `updated_at` moves whenever any of them can, so an unchanged one costs no request.
type DetailCache = HashMap<(String, u64), (String, Value)>;
static DETAILS: LazyLock<Mutex<DetailCache>> = LazyLock::new(Default::default);

/// A commit's title by (project base, sha); a commit never changes.
static COMMITS: LazyLock<Mutex<HashMap<(String, String), String>>> =
    LazyLock::new(Default::default);

/// What `pull_checks` learned about a merge request: its head pipeline's status and who
/// approved, keyed by (project base, iid) with the `updated_at` it was fetched at. The list
/// carries neither, so the next list applies them from here.
#[derive(Clone)]
struct MrExtra {
    updated_at: String,
    checks: Option<RunStatus>,
    approved_by: Vec<User>,
}
static MR_EXTRAS: LazyLock<Mutex<HashMap<(String, u64), MrExtra>>> =
    LazyLock::new(Default::default);

pub struct GitLab;

/// A GitLab user as the API embeds one.
#[derive(Debug, Clone, PartialEq)]
pub struct User {
    pub id: u64,
    pub name: String,
}

/// A request the provider would send, built apart from sending so mutating calls are tested by
/// their shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
}

fn str_at<'a>(v: &'a Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn string_at(v: &Value, ptr: &str) -> Option<String> {
    str_at(v, ptr).map(str::to_string)
}

fn u64_at(v: &Value, ptr: &str) -> Option<u64> {
    v.pointer(ptr).and_then(Value::as_u64)
}

/// `https://<host>/api/v4`; `host` keeps a `:port` from the remote.
fn api_root(repo: &RepoRef) -> String {
    format!("https://{}/api/v4", repo.host)
}

/// The project's API base. Its id is the full path, nested groups included, encoded as one
/// segment (`group%2Fsub%2Frepo`).
pub fn project_base(repo: &RepoRef) -> Result<String, ForgeError> {
    if repo.path.len() < 2 || repo.path.iter().any(|s| s.is_empty()) {
        return Err(ForgeError::other(
            "A GitLab repo path is a group (or nested groups) and a project.",
        ));
    }
    Ok(format!(
        "{}/projects/{}",
        api_root(repo),
        percent_encode(&repo.path.join("/"))
    ))
}

fn auth(cx: &Cx) -> String {
    format!("Bearer {}", cx.token.value)
}

/// A pipeline's or a job's `status`.
pub fn map_status(status: &str) -> RunStatus {
    match status {
        "created" | "waiting_for_resource" | "preparing" | "pending" | "scheduled" => {
            RunStatus::Queued
        }
        // `canceling` is a pipeline still stopping its jobs.
        "running" | "canceling" => RunStatus::Running,
        "manual" => RunStatus::Waiting,
        "success" => RunStatus::Success,
        "failed" => RunStatus::Failure,
        "canceled" => RunStatus::Cancelled,
        "skipped" => RunStatus::Skipped,
        _ => RunStatus::Other,
    }
}

/// Still moving, so a cached snapshot of it goes stale without its merge request changing.
fn in_flight(status: Option<RunStatus>) -> bool {
    matches!(status, Some(RunStatus::Queued | RunStatus::Running))
}

pub fn runs_url(base: &str, branch: Option<&str>) -> String {
    let mut url = format!("{base}/pipelines?per_page={MAX_RUNS}&order_by=id&sort=desc");
    if let Some(b) = branch {
        url.push_str(&format!("&ref={}", percent_encode(b)));
    }
    url
}

/// The detail fields `map_run` reads, kept small for the cache.
pub fn trim_detail(detail: &Value) -> Value {
    json!({
        "name": detail.get("name").cloned().unwrap_or(Value::Null),
        "status": detail.get("status").cloned().unwrap_or(Value::Null),
        "user": { "name": detail.pointer("/user/name").cloned().unwrap_or(Value::Null) },
        "started_at": detail.get("started_at").cloned().unwrap_or(Value::Null),
        "finished_at": detail.get("finished_at").cloned().unwrap_or(Value::Null),
    })
}

/// One pipeline from the list, with its detail and commit title when they were fetched.
pub fn map_run(
    v: &Value,
    detail: Option<&Value>,
    commit_title: Option<&str>,
    repo_web_url: &str,
) -> Option<Run> {
    let id = u64_at(v, "/id")?;
    let number = u64_at(v, "/iid");
    let detail = detail.unwrap_or(&Value::Null);
    // The detail is newer when it was fetched for this same `updated_at`, but either serves.
    let raw = str_at(detail, "/status")
        .or_else(|| str_at(v, "/status"))
        .unwrap_or("");
    let branch = string_at(v, "/ref");
    let name = string_at(detail, "/name").unwrap_or_else(|| match number {
        Some(n) => format!("Pipeline #{n}"),
        None => format!("Pipeline {id}"),
    });
    let title = commit_title
        .map(str::to_string)
        .or_else(|| branch.clone())
        .unwrap_or_default();
    Some(Run {
        id: id.to_string(),
        number,
        name,
        title,
        branch,
        sha: string_at(v, "/sha"),
        event: string_at(v, "/source"),
        status: map_status(raw),
        raw_status: raw.to_string(),
        actor: string_at(detail, "/user/name"),
        created_at: string_at(v, "/created_at").unwrap_or_default(),
        started_at: string_at(detail, "/started_at"),
        finished_at: string_at(detail, "/finished_at"),
        web_url: string_at(v, "/web_url")
            .unwrap_or_else(|| format!("{repo_web_url}/-/pipelines/{id}")),
    })
}

/// One job; GitLab jobs have no steps.
pub fn map_job(v: &Value) -> Option<Job> {
    let id = u64_at(v, "/id")?;
    Some(Job {
        id: id.to_string(),
        name: string_at(v, "/name").unwrap_or_else(|| format!("Job {id}")),
        status: map_status(str_at(v, "/status").unwrap_or("")),
        started_at: string_at(v, "/started_at"),
        finished_at: string_at(v, "/finished_at"),
        web_url: string_at(v, "/web_url"),
        steps: Vec::new(),
    })
}

/// `POST /pipelines/:pid/retry`, which retries the pipeline's failed and canceled jobs.
pub fn retry_request(base: &str, run_id: &str) -> Request {
    Request {
        method: "POST",
        url: format!("{base}/pipelines/{}/retry", percent_encode(run_id)),
    }
}

pub fn cancel_request(base: &str, run_id: &str) -> Request {
    Request {
        method: "POST",
        url: format!("{base}/pipelines/{}/cancel", percent_encode(run_id)),
    }
}

pub fn pulls_url(base: &str, open_only: bool, branch: Option<&str>) -> String {
    let state = if open_only { "opened" } else { "all" };
    let mut url = format!(
        "{base}/merge_requests?state={state}&order_by=updated_at&sort=desc&per_page={MAX_PULLS}"
    );
    if let Some(b) = branch {
        url.push_str(&format!("&source_branch={}", percent_encode(b)));
    }
    url
}

/// `X-Total`, the count of all matching merge requests. GitLab leaves it out past 10,000.
pub fn total_of(headers: &[(String, String)]) -> Option<u64> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("x-total"))
        .and_then(|(_, v)| v.trim().parse().ok())
}

fn user_of(v: &Value) -> Option<User> {
    Some(User {
        id: u64_at(v, "/id")?,
        name: string_at(v, "/name")
            .or_else(|| string_at(v, "/username"))
            .unwrap_or_default(),
    })
}

/// `approved_by` of the merge request approvals endpoint.
pub fn map_approved_by(v: &Value) -> Vec<User> {
    v.get("approved_by")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| a.get("user").and_then(user_of))
        .collect()
}

/// `head_pipeline.status` of a single merge request; the list leaves `head_pipeline` out.
pub fn map_head_pipeline(v: &Value) -> Option<RunStatus> {
    str_at(v, "/head_pipeline/status").map(map_status)
}

/// One merge request. `approved_by` is `None` until `pull_checks` has fetched it, and then
/// reviewers who approved read as approved. GitLab has no "changes requested", so every other
/// reviewer is pending.
pub fn map_pull(
    v: &Value,
    viewer: Option<u64>,
    checks: Option<RunStatus>,
    approved_by: Option<&[User]>,
) -> Option<PullRequest> {
    let number = u64_at(v, "/iid")?;
    let approved_by = approved_by.unwrap_or(&[]);
    let approved = |id: u64| approved_by.iter().any(|u| u.id == id);
    let mut reviewing: Vec<(User, ReviewState)> = v
        .get("reviewers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(user_of)
        .map(|u| {
            let state = if approved(u.id) {
                ReviewState::Approved
            } else {
                ReviewState::Pending
            };
            (u, state)
        })
        .collect();
    // Anyone eligible may approve without being asked.
    for u in approved_by {
        if !reviewing.iter().any(|(r, _)| r.id == u.id) {
            reviewing.push((u.clone(), ReviewState::Approved));
        }
    }
    let review_decision = if reviewing.iter().any(|(_, s)| *s == ReviewState::Approved) {
        Some(ReviewState::Approved)
    } else if reviewing.is_empty() {
        None
    } else {
        Some(ReviewState::Pending)
    };
    let is_mine = viewer.is_some_and(|me| u64_at(v, "/author/id") == Some(me));
    let review_requested = viewer.is_some_and(|me| {
        reviewing
            .iter()
            .any(|(u, s)| u.id == me && *s == ReviewState::Pending)
    });
    let state = match str_at(v, "/state") {
        Some("merged") => PullState::Merged,
        Some("closed" | "locked") => PullState::Closed,
        _ => PullState::Open,
    };
    let draft = v
        .get("draft")
        .or_else(|| v.get("work_in_progress"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(PullRequest {
        id: number.to_string(),
        number,
        title: string_at(v, "/title").unwrap_or_default(),
        author: string_at(v, "/author/name")
            .or_else(|| string_at(v, "/author/username"))
            .unwrap_or_default(),
        draft,
        state,
        source_branch: string_at(v, "/source_branch").unwrap_or_default(),
        target_branch: string_at(v, "/target_branch").unwrap_or_default(),
        created_at: string_at(v, "/created_at").unwrap_or_default(),
        updated_at: string_at(v, "/updated_at").unwrap_or_default(),
        web_url: string_at(v, "/web_url").unwrap_or_default(),
        review_decision,
        reviewers: reviewing
            .into_iter()
            .map(|(u, state)| Reviewer {
                login: u.name,
                state,
            })
            .collect(),
        checks: map_head_pipeline(v).or(checks),
        checks_pending: false,
        is_mine,
        review_requested,
    })
}

pub fn map_default_branch(v: &Value) -> Option<String> {
    string_at(v, "/default_branch")
}

fn token_key(cx: &Cx) -> u64 {
    let mut h = DefaultHasher::new();
    cx.token.value.hash(&mut h);
    h.finish()
}

fn bounded_insert<K: Hash + Eq, V>(map: &mut HashMap<K, V>, k: K, v: V) {
    if map.len() >= CACHE_MAX {
        map.clear();
    }
    map.insert(k, v);
}

/// `f` over `items` a few at a time, keeping their order.
fn parallel<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    thread::scope(|scope| {
        for _ in 0..WORKERS.min(items.len()) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    let r = f(item);
                    out.lock_or_recover()[i] = Some(r);
                }
            });
        }
    });
    out.into_inner().unwrap().into_iter().flatten().collect()
}

impl GitLab {
    /// The viewer's user id, which marks the merge requests that are theirs or await their
    /// review. Only a success is cached, so a token replaced after a failure is asked again.
    fn viewer(&self, cx: &Cx, repo: &RepoRef) -> Result<Option<u64>, ForgeError> {
        let key = (repo.host.to_ascii_lowercase(), token_key(cx));
        if let Some(id) = VIEWERS.lock_or_recover().get(&key) {
            return Ok(Some(*id));
        }
        let user: Value =
            cx.http
                .get_json(&format!("{}/user", api_root(repo)), Some(&auth(cx)), ACCEPT)?;
        let id = u64_at(&user, "/id");
        if let Some(id) = id {
            VIEWERS.lock_or_recover().insert(key, id);
        }
        Ok(id)
    }

    /// A pipeline's trimmed detail, from the cache while its `updated_at` holds. A failed
    /// request answers `None`, leaving the run with what the list says.
    fn detail(cx: &Cx, base: &str, item: &Value) -> Option<Value> {
        let id = u64_at(item, "/id")?;
        let updated = str_at(item, "/updated_at").unwrap_or_default();
        let key = (base.to_string(), id);
        if let Some((at, d)) = DETAILS.lock_or_recover().get(&key) {
            if at == updated {
                return Some(d.clone());
            }
        }
        let url = format!("{base}/pipelines/{id}");
        let d = trim_detail(
            &cx.http
                .get_json::<Value>(&url, Some(&auth(cx)), ACCEPT)
                .ok()?,
        );
        bounded_insert(
            &mut DETAILS.lock_or_recover(),
            key,
            (updated.to_string(), d.clone()),
        );
        Some(d)
    }

    fn commit_title(cx: &Cx, base: &str, sha: &str) -> Option<String> {
        let key = (base.to_string(), sha.to_string());
        if let Some(t) = COMMITS.lock_or_recover().get(&key) {
            return Some(t.clone());
        }
        let url = format!("{base}/repository/commits/{}", percent_encode(sha));
        let commit = cx
            .http
            .get_json::<Value>(&url, Some(&auth(cx)), ACCEPT)
            .ok()?;
        let title = string_at(&commit, "/title")?;
        bounded_insert(&mut COMMITS.lock_or_recover(), key, title.clone());
        Some(title)
    }

    /// A merge request's head pipeline and approvals, cached against `updated`. Either request
    /// failing leaves it uncached, so the next list asks again.
    fn fetch_extra(cx: &Cx, base: &str, iid: u64, updated: &str) -> Option<MrExtra> {
        let auth = auth(cx);
        let mr: Value = cx
            .http
            .get_json(&format!("{base}/merge_requests/{iid}"), Some(&auth), ACCEPT)
            .ok()?;
        let approvals: Value = cx
            .http
            .get_json(
                &format!("{base}/merge_requests/{iid}/approvals"),
                Some(&auth),
                ACCEPT,
            )
            .ok()?;
        let extra = MrExtra {
            updated_at: updated.to_string(),
            checks: map_head_pipeline(&mr),
            approved_by: map_approved_by(&approvals),
        };
        bounded_insert(
            &mut MR_EXTRAS.lock_or_recover(),
            (base.to_string(), iid),
            extra.clone(),
        );
        Some(extra)
    }

    fn send(cx: &Cx, req: &Request) -> Result<(), ForgeError> {
        debug_assert_eq!(req.method, "POST");
        cx.http.post_json(&req.url, Some(&auth(cx)), ACCEPT, None)?;
        Ok(())
    }
}

impl ForgeProvider for GitLab {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Gitlab
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            // A pipeline `retry` retries its failed jobs, which serves both.
            rerun: true,
            rerun_failed: true,
            cancel: true,
            job_logs: true,
            drafts: true,
            pr_noun: "merge request".into(),
            run_noun: "pipeline".into(),
            min_poll_secs: 10,
            accounts: false,
        }
    }

    fn runs(&self, cx: &Cx, repo: &RepoRef, branch: Option<&str>) -> Result<Vec<Run>, ForgeError> {
        let base = project_base(repo)?;
        let list: Value = cx
            .http
            .get_json(&runs_url(&base, branch), Some(&auth(cx)), ACCEPT)?;
        let items: &[Value] = list.as_array().map_or(&[], Vec::as_slice);
        let filled = parallel(items, |item| {
            let detail = Self::detail(cx, &base, item);
            let title = str_at(item, "/sha").and_then(|sha| Self::commit_title(cx, &base, sha));
            (detail, title)
        });
        Ok(items
            .iter()
            .zip(filled)
            .filter_map(|(item, (detail, title))| {
                map_run(item, detail.as_ref(), title.as_deref(), &repo.web_url)
            })
            .collect())
    }

    fn jobs(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<Vec<Job>, ForgeError> {
        let url = format!(
            "{}/pipelines/{}/jobs?per_page=100",
            project_base(repo)?,
            percent_encode(run_id)
        );
        let list: Value = cx.http.get_json(&url, Some(&auth(cx)), ACCEPT)?;
        let mut jobs: Vec<Job> = list
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(map_job)
            .collect();
        // The API lists newest first; the pane reads a pipeline top to bottom.
        jobs.reverse();
        Ok(jobs)
    }

    fn log(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        _run_id: &str,
        job_id: &str,
    ) -> Result<JobLog, ForgeError> {
        let url = format!(
            "{}/jobs/{}/trace",
            project_base(repo)?,
            percent_encode(job_id)
        );
        match cx.http.get_text_tail(&url, Some(&auth(cx)), &[], LOG_MAX) {
            Ok((text, truncated)) => Ok(JobLog { text, truncated }),
            // A job that hasn't started has no trace yet.
            Err(e) if e.kind == ForgeErrorKind::NotFound => Ok(JobLog {
                text: String::new(),
                truncated: false,
            }),
            Err(e) => Err(e),
        }
    }

    fn rerun(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        run_id: &str,
        _failed_only: bool,
    ) -> Result<(), ForgeError> {
        Self::send(cx, &retry_request(&project_base(repo)?, run_id))
    }

    fn cancel(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<(), ForgeError> {
        Self::send(cx, &cancel_request(&project_base(repo)?, run_id))
    }

    fn pulls(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        open_only: bool,
        branch: Option<&str>,
    ) -> Result<PullList, ForgeError> {
        let base = project_base(repo)?;
        // Uncached, since it also reads `X-Total`; GitLab's ETags are partial anyway.
        let (list, headers) = cx.http.get_json_with_headers::<Value>(
            &pulls_url(&base, open_only, branch),
            Some(&auth(cx)),
            ACCEPT,
        )?;
        let viewer = self.viewer(cx, repo)?;
        let extras = MR_EXTRAS.lock_or_recover().clone();
        let items = list
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                let iid = u64_at(v, "/iid")?;
                let updated = str_at(v, "/updated_at").unwrap_or_default();
                // A pipeline finishing doesn't touch its merge request, so one still in flight
                // is asked again.
                let extra = extras
                    .get(&(base.clone(), iid))
                    .filter(|e| e.updated_at == updated && !in_flight(e.checks));
                let mut pull = map_pull(
                    v,
                    viewer,
                    extra.and_then(|e| e.checks),
                    extra.map(|e| e.approved_by.as_slice()),
                )?;
                // A merged or closed merge request's pipeline and approvals are history.
                pull.checks_pending = pull.state == PullState::Open && extra.is_none();
                Some(pull)
            })
            .collect();
        Ok(PullList {
            items,
            total: total_of(&headers),
        })
    }

    fn pull_checks(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        pulls: &[PullChecksQuery],
    ) -> Result<Vec<PullChecks>, ForgeError> {
        let base = project_base(repo)?;
        let found = parallel(pulls, |q| {
            let iid = q.id.parse::<u64>().ok()?;
            let extra = Self::fetch_extra(cx, &base, iid, &q.updated_at);
            Some(PullChecks {
                id: q.id.clone(),
                checks: extra.and_then(|e| e.checks),
            })
        });
        Ok(found.into_iter().flatten().collect())
    }

    fn default_branch(&self, cx: &Cx, repo: &RepoRef) -> Result<Option<String>, ForgeError> {
        let v: Value = cx
            .http
            .get_json(&project_base(repo)?, Some(&auth(cx)), ACCEPT)?;
        Ok(map_default_branch(&v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_ref(host: &str, path: &[&str]) -> RepoRef {
        RepoRef {
            provider: ProviderKind::Gitlab,
            host: host.into(),
            path: path.iter().map(|s| s.to_string()).collect(),
            web_url: format!("https://{host}/{}", path.join("/")),
        }
    }

    const BASE: &str = "https://gitlab.example.com/api/v4/projects/my-group%2Fmy-project";

    #[test]
    fn nested_group_paths_encode_as_one_project_id() {
        assert_eq!(
            project_base(&repo_ref("gitlab.com", &["group", "sub", "deeper", "repo"])).unwrap(),
            "https://gitlab.com/api/v4/projects/group%2Fsub%2Fdeeper%2Frepo"
        );
        assert_eq!(
            project_base(&repo_ref("gitlab.example.com:8443", &["team", "my repo"])).unwrap(),
            "https://gitlab.example.com:8443/api/v4/projects/team%2Fmy%20repo"
        );
        assert!(project_base(&repo_ref("gitlab.com", &["repo"])).is_err());
        assert!(project_base(&repo_ref("gitlab.com", &["group", ""])).is_err());
    }

    #[test]
    fn every_status() {
        use RunStatus as S;
        let table = [
            ("created", S::Queued),
            ("waiting_for_resource", S::Queued),
            ("preparing", S::Queued),
            ("pending", S::Queued),
            ("scheduled", S::Queued),
            ("running", S::Running),
            ("canceling", S::Running),
            ("manual", S::Waiting),
            ("success", S::Success),
            ("failed", S::Failure),
            ("canceled", S::Cancelled),
            ("skipped", S::Skipped),
            ("something_new", S::Other),
            ("", S::Other),
        ];
        for (raw, want) in table {
            assert_eq!(map_status(raw), want, "{raw}");
        }
    }

    /// From the pipelines API docs: a list item and the matching detail.
    fn pipeline_item() -> Value {
        json!({
            "id": 47,
            "iid": 12,
            "project_id": 1,
            "status": "pending",
            "source": "push",
            "ref": "new-pipeline",
            "sha": "a91957a858320c0e17f3a0eca7cfacbff50ea29a",
            "name": "Build pipeline",
            "web_url": "https://example.com/foo/bar/pipelines/47",
            "created_at": "2016-08-11T11:28:34.085Z",
            "updated_at": "2016-08-11T11:32:35.169Z"
        })
    }

    fn pipeline_detail() -> Value {
        json!({
            "id": 47,
            "iid": 12,
            "project_id": 1,
            "name": "Build pipeline",
            "status": "success",
            "ref": "new-pipeline",
            "sha": "a91957a858320c0e17f3a0eca7cfacbff50ea29a",
            "before_sha": "a91957a858320c0e17f3a0eca7cfacbff50ea29a",
            "tag": false,
            "yaml_errors": null,
            "user": {
                "name": "Example User",
                "username": "example",
                "id": 1,
                "state": "active",
                "avatar_url": "http://www.gravatar.com/avatar/x",
                "web_url": "http://localhost:3000/example"
            },
            "created_at": "2016-08-11T11:28:34.085Z",
            "updated_at": "2016-08-11T11:32:35.169Z",
            "started_at": "2016-08-11T11:28:40.000Z",
            "finished_at": "2016-08-11T11:32:35.145Z",
            "committed_at": null,
            "duration": 123.65,
            "queued_duration": 0.010,
            "coverage": "30.0",
            "web_url": "https://example.com/foo/bar/pipelines/47"
        })
    }

    #[test]
    fn a_pipeline_maps_to_a_run() {
        let detail = trim_detail(&pipeline_detail());
        let r = map_run(
            &pipeline_item(),
            Some(&detail),
            Some("Fix the export"),
            "https://w",
        )
        .unwrap();
        assert_eq!((r.id.as_str(), r.number), ("47", Some(12)));
        assert_eq!(
            (r.name.as_str(), r.title.as_str()),
            ("Build pipeline", "Fix the export")
        );
        assert_eq!(r.branch.as_deref(), Some("new-pipeline"));
        assert_eq!(
            r.sha.as_deref(),
            Some("a91957a858320c0e17f3a0eca7cfacbff50ea29a")
        );
        assert_eq!(r.event.as_deref(), Some("push"));
        // The detail's status is the newer one.
        assert_eq!(
            (r.status, r.raw_status.as_str()),
            (RunStatus::Success, "success")
        );
        assert_eq!(r.actor.as_deref(), Some("Example User"));
        assert_eq!(r.created_at, "2016-08-11T11:28:34.085Z");
        assert_eq!(r.started_at.as_deref(), Some("2016-08-11T11:28:40.000Z"));
        assert_eq!(r.finished_at.as_deref(), Some("2016-08-11T11:32:35.145Z"));
        assert_eq!(r.web_url, "https://example.com/foo/bar/pipelines/47");
    }

    #[test]
    fn a_pipeline_without_its_detail_or_commit() {
        let mut item = pipeline_item();
        item.as_object_mut().unwrap().remove("web_url");
        let r = map_run(&item, None, None, "https://gitlab.com/g/p").unwrap();
        assert_eq!(
            (r.name.as_str(), r.title.as_str()),
            ("Pipeline #12", "new-pipeline")
        );
        assert_eq!(
            (r.status, r.raw_status.as_str()),
            (RunStatus::Queued, "pending")
        );
        assert_eq!((r.actor, r.started_at, r.finished_at), (None, None, None));
        assert_eq!(r.web_url, "https://gitlab.com/g/p/-/pipelines/47");
        // A null pipeline name falls back too.
        let mut d = pipeline_detail();
        d["name"] = Value::Null;
        let r = map_run(&pipeline_item(), Some(&trim_detail(&d)), None, "w").unwrap();
        assert_eq!(r.name, "Pipeline #12");
        assert!(map_run(&json!({ "iid": 1 }), None, None, "w").is_none());
    }

    #[test]
    fn jobs_have_no_steps() {
        // From the jobs API docs.
        let v = json!({
            "id": 6,
            "name": "rspec:other",
            "stage": "test",
            "status": "failed",
            "ref": "main",
            "created_at": "2015-12-24T15:51:21.802Z",
            "started_at": "2015-12-24T17:54:24.729Z",
            "finished_at": "2015-12-24T17:54:24.921Z",
            "duration": 0.192,
            "web_url": "https://example.com/foo/bar/-/jobs/6",
            "allow_failure": false
        });
        let j = map_job(&v).unwrap();
        assert_eq!(
            (j.id.as_str(), j.name.as_str(), j.status),
            ("6", "rspec:other", RunStatus::Failure)
        );
        assert_eq!(j.started_at.as_deref(), Some("2015-12-24T17:54:24.729Z"));
        assert_eq!(j.finished_at.as_deref(), Some("2015-12-24T17:54:24.921Z"));
        assert_eq!(
            j.web_url.as_deref(),
            Some("https://example.com/foo/bar/-/jobs/6")
        );
        assert!(j.steps.is_empty());
        let j = map_job(&json!({ "id": 7, "status": "manual" })).unwrap();
        assert_eq!((j.name.as_str(), j.status), ("Job 7", RunStatus::Waiting));
        assert!(map_job(&json!({ "name": "no id" })).is_none());
    }

    #[test]
    fn retry_and_cancel_request_shapes() {
        assert_eq!(
            retry_request(BASE, "47"),
            Request {
                method: "POST",
                url: format!("{BASE}/pipelines/47/retry"),
            }
        );
        assert_eq!(
            cancel_request(BASE, "47"),
            Request {
                method: "POST",
                url: format!("{BASE}/pipelines/47/cancel"),
            }
        );
        // An id is one path segment, whatever it holds.
        assert_eq!(
            cancel_request(BASE, "4/7").url,
            format!("{BASE}/pipelines/4%2F7/cancel")
        );
    }

    #[test]
    fn list_urls() {
        assert_eq!(
            runs_url(BASE, None),
            format!("{BASE}/pipelines?per_page=20&order_by=id&sort=desc")
        );
        assert_eq!(
            runs_url(BASE, Some("feat/a b")),
            format!("{BASE}/pipelines?per_page=20&order_by=id&sort=desc&ref=feat%2Fa%20b")
        );
        let open = pulls_url(BASE, true, None);
        assert!(open.starts_with(&format!("{BASE}/merge_requests?state=opened&")));
        assert!(open.contains("per_page=50") && !open.contains("source_branch"));
        let all = pulls_url(BASE, false, Some("feat/x"));
        assert!(all.contains("state=all"));
        assert!(all.ends_with("&source_branch=feat%2Fx"));
    }

    #[test]
    fn total_from_the_header() {
        let h = |v: &str| vec![("x-total".to_string(), v.to_string())];
        assert_eq!(total_of(&h("63")), Some(63));
        assert_eq!(total_of(&h("")), None);
        assert_eq!(total_of(&[]), None);
    }

    /// From the merge requests API docs, with people renamed.
    fn mr() -> Value {
        json!({
            "id": 1,
            "iid": 1,
            "project_id": 3,
            "title": "test1",
            "description": "fixed login page css paddings",
            "state": "opened",
            "created_at": "2017-04-29T08:46:00Z",
            "updated_at": "2017-04-29T08:46:00Z",
            "target_branch": "main",
            "source_branch": "test1",
            "upvotes": 0,
            "downvotes": 0,
            "author": { "id": 1, "name": "Author Person", "username": "author", "state": "active" },
            "assignees": [],
            "reviewers": [
                { "id": 2, "name": "Reviewer One", "username": "reviewer1", "state": "active" },
                { "id": 3, "name": "Reviewer Two", "username": "reviewer2", "state": "active" }
            ],
            "source_project_id": 2,
            "target_project_id": 3,
            "draft": false,
            "work_in_progress": false,
            "merge_status": "can_be_merged",
            "detailed_merge_status": "not_open",
            "sha": "8888888888888888888888888888888888888888",
            "web_url": "http://gitlab.example.com/my-group/my-project/merge_requests/1",
            "references": { "short": "!1", "relative": "!1", "full": "my-group/my-project!1" }
        })
    }

    /// From the merge request approvals API docs, with people renamed.
    fn approvals(ids: &[(u64, &str)]) -> Value {
        json!({
            "id": 5,
            "iid": 1,
            "project_id": 3,
            "title": "test1",
            "state": "opened",
            "merge_status": "can_be_merged",
            "approved": !ids.is_empty(),
            "approvals_required": 2,
            "approvals_left": 1,
            "approved_by": ids.iter().map(|(id, name)| json!({
                "user": { "name": name, "username": "u", "id": id, "state": "active" }
            })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn a_merge_request_without_approvals() {
        let pr = map_pull(&mr(), Some(3), None, None).unwrap();
        assert_eq!(
            (pr.id.as_str(), pr.number, pr.title.as_str()),
            ("1", 1, "test1")
        );
        assert_eq!(pr.author, "Author Person");
        assert_eq!((pr.state, pr.draft), (PullState::Open, false));
        assert_eq!(
            (pr.source_branch.as_str(), pr.target_branch.as_str()),
            ("test1", "main")
        );
        assert_eq!(
            pr.web_url,
            "http://gitlab.example.com/my-group/my-project/merge_requests/1"
        );
        let got: Vec<(&str, ReviewState)> = pr
            .reviewers
            .iter()
            .map(|r| (r.login.as_str(), r.state))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Reviewer One", ReviewState::Pending),
                ("Reviewer Two", ReviewState::Pending)
            ]
        );
        assert_eq!(pr.review_decision, Some(ReviewState::Pending));
        assert!(pr.review_requested && !pr.is_mine);
        assert_eq!(pr.checks, None);
    }

    #[test]
    fn a_merge_request_with_approvals() {
        let approved = map_approved_by(&approvals(&[(3, "Reviewer Two"), (9, "Drive By")]));
        let pr = map_pull(&mr(), Some(3), Some(RunStatus::Success), Some(&approved)).unwrap();
        let got: Vec<(&str, ReviewState)> = pr
            .reviewers
            .iter()
            .map(|r| (r.login.as_str(), r.state))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Reviewer One", ReviewState::Pending),
                ("Reviewer Two", ReviewState::Approved),
                ("Drive By", ReviewState::Approved),
            ]
        );
        assert_eq!(pr.review_decision, Some(ReviewState::Approved));
        // The viewer approved, so nothing is asked of them any more.
        assert!(!pr.review_requested);
        assert_eq!(pr.checks, Some(RunStatus::Success));
        let pr = map_pull(&mr(), Some(1), None, Some(&[])).unwrap();
        assert!(pr.is_mine && !pr.review_requested);
        assert!(map_approved_by(&json!({})).is_empty());
    }

    #[test]
    fn drafts_states_and_head_pipelines() {
        let mut v = mr();
        v["draft"] = json!(true);
        v["reviewers"] = json!([]);
        v["state"] = json!("merged");
        // A single merge request carries its head pipeline.
        v["head_pipeline"] = json!({ "id": 47, "status": "failed" });
        let pr = map_pull(&v, None, Some(RunStatus::Success), None).unwrap();
        assert!(pr.draft && !pr.is_mine && !pr.review_requested);
        assert_eq!((pr.state, pr.review_decision), (PullState::Merged, None));
        assert_eq!(pr.checks, Some(RunStatus::Failure));
        assert_eq!(map_head_pipeline(&mr()), None);
        for (state, want) in [("closed", PullState::Closed), ("locked", PullState::Closed)] {
            v["state"] = json!(state);
            assert_eq!(map_pull(&v, None, None, None).unwrap().state, want);
        }
        // Older servers say `work_in_progress`.
        let pr = map_pull(
            &json!({ "iid": 4, "work_in_progress": true }),
            None,
            None,
            None,
        )
        .unwrap();
        assert!(pr.draft);
        assert!(map_pull(&json!({ "id": 4 }), None, None, None).is_none());
    }

    #[test]
    fn default_branch_from_the_project() {
        assert_eq!(
            map_default_branch(&json!({ "default_branch": "main" })).as_deref(),
            Some("main")
        );
        assert_eq!(map_default_branch(&json!({ "default_branch": null })), None);
    }

    #[test]
    fn in_flight_checks_are_asked_again() {
        assert!(in_flight(Some(RunStatus::Running)) && in_flight(Some(RunStatus::Queued)));
        assert!(!in_flight(Some(RunStatus::Success)) && !in_flight(None));
    }

    #[test]
    fn parallel_keeps_order() {
        let items: Vec<u32> = (0..30).collect();
        assert_eq!(
            parallel(&items, |n| n * 2),
            items.iter().map(|n| n * 2).collect::<Vec<_>>()
        );
        assert!(parallel(&[] as &[u32], |n| *n).is_empty());
    }
}
