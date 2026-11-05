//! The Bitbucket Cloud provider (docs/design.md section 3.20), over the 2.0 REST API with a
//! Bearer token. The JSON-to-DTO mapping is pure functions over `serde_json::Value` so it tests
//! without the network.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value, json};

use super::auth::TokenSource;
use super::remote::percent_encode;
use super::types::{
    Capabilities, ForgeError, ForgeErrorKind, Job, JobLog, ProviderKind, PullList, PullRequest,
    RepoRef, ReviewState, Reviewer, Run, RunStatus,
};
use super::{Cx, ForgeProvider};

const API: &str = "https://api.bitbucket.org/2.0";
const HOST: &str = "bitbucket.org";
const LOG_MAX: usize = 1024 * 1024;
const MAX_PAGES: usize = 5;
const ACCEPT: &[(&str, &str)] = &[("Accept", "application/json")];

/// The viewer's uuid per token (by hash, never the token itself); `None` when the token
/// can't read `/user`.
static VIEWERS: LazyLock<Mutex<HashMap<u64, Option<String>>>> = LazyLock::new(Default::default);

/// A PR's check rollup by (repo, PR id), with the `updated_on` it was fetched at. A new build
/// status bumps the PR's `updated_on`, so an unchanged PR keeps its rollup without a request,
/// which keeps polling inside Bitbucket's 1,000 requests an hour.
type ChecksCache = HashMap<(String, u64), (String, Option<RunStatus>)>;
static CHECKS: LazyLock<Mutex<ChecksCache>> = LazyLock::new(Default::default);

pub struct Bitbucket;

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

fn repo_base(repo: &RepoRef) -> Result<String, ForgeError> {
    // Bitbucket Data Center has another API, and its host's Git Credential Manager token must
    // never be sent to api.bitbucket.org.
    if !repo.host.eq_ignore_ascii_case(HOST) {
        return Err(ForgeError::new(
            ForgeErrorKind::UnsupportedHost,
            "Bitbucket Data Center isn't supported yet",
        ));
    }
    let [ws, slug] = repo.path.as_slice() else {
        return Err(ForgeError::other(
            "A Bitbucket repo path is a workspace and a slug.",
        ));
    };
    Ok(format!(
        "{API}/repositories/{}/{}",
        percent_encode(ws),
        percent_encode(slug)
    ))
}

fn auth(cx: &Cx) -> String {
    format!("Bearer {}", cx.token.value)
}

/// Rewords errors for the token that produced them. A 401 passes through as `signedOut`, where
/// `decorate` words the stored-token and no-token cases; a Git Credential Manager token gets
/// its own wording, since its sign-in lacks the pipeline and pull request scopes. That message
/// avoids the word the front end reads as "a stored token was refused".
pub fn reword(e: ForgeError, source: &TokenSource) -> ForgeError {
    let gcm = matches!(source, TokenSource::GitCredential { .. });
    if gcm
        && matches!(
            e.kind,
            ForgeErrorKind::Forbidden | ForgeErrorKind::SignedOut
        )
    {
        return ForgeError::new(
            ForgeErrorKind::SignedOut,
            "Git Credential Manager's Bitbucket sign-in can't read pipelines or pull requests. \
             Bashboard needs a Bitbucket API token; run bb auth bitbucket to add one.",
        );
    }
    e
}

/// `state` of a pipeline or a step, as a status and the raw name shown beside it.
pub fn map_state(state: &Value) -> (RunStatus, String) {
    let name = str_at(state, "/name").unwrap_or("");
    let stage = str_at(state, "/stage/name");
    let result = str_at(state, "/result/name");
    match name {
        "PENDING" | "READY" | "PARSING" => (RunStatus::Queued, name.to_string()),
        "PAUSED" | "HALTED" => (RunStatus::Waiting, name.to_string()),
        "IN_PROGRESS" | "RUNNING" => match stage {
            Some(s @ ("PAUSED" | "HALTED")) => (RunStatus::Waiting, s.to_string()),
            Some(s) => (RunStatus::Running, s.to_string()),
            None => (RunStatus::Running, name.to_string()),
        },
        "COMPLETED" => {
            let status = match result {
                Some("SUCCESSFUL") => RunStatus::Success,
                Some("FAILED" | "ERROR") => RunStatus::Failure,
                Some("STOPPED") => RunStatus::Cancelled,
                Some("NOT_RUN" | "SKIPPED") => RunStatus::Skipped,
                _ => RunStatus::Other,
            };
            (status, result.unwrap_or(name).to_string())
        }
        _ => (RunStatus::Other, name.to_string()),
    }
}

/// One pipeline. `web_url` is the repo's page on bitbucket.org.
pub fn map_run(v: &Value, web_url: &str) -> Option<Run> {
    let id = string_at(v, "/uuid")?;
    let number = v.get("build_number").and_then(Value::as_u64);
    let target = v.get("target").unwrap_or(&Value::Null);
    let branch = string_at(target, "/ref_name").or_else(|| string_at(target, "/source"));
    let (status, raw_status) = map_state(v.get("state").unwrap_or(&Value::Null));
    // A pull request pipeline's selector pattern is a glob such as `**`, which reads as noise.
    let pull = target
        .pointer("/pullrequest/id")
        .and_then(Value::as_u64)
        .filter(|_| str_at(target, "/selector/type") == Some("pull-requests"));
    let name = match pull {
        Some(id) => format!("Pull request #{id}"),
        None => string_at(target, "/selector/pattern").unwrap_or_else(|| match number {
            Some(n) => format!("Pipeline #{n}"),
            None => "Pipeline".into(),
        }),
    };
    // The pipelines list carries the commit's hash but not its message.
    let title = str_at(target, "/commit/message")
        .and_then(first_line)
        .or_else(|| string_at(target, "/pullrequest/title"))
        .or_else(|| branch.clone())
        .unwrap_or_default();
    Some(Run {
        id,
        number,
        name,
        title,
        branch,
        sha: string_at(target, "/commit/hash"),
        event: str_at(v, "/trigger/name").map(str::to_ascii_lowercase),
        status,
        raw_status,
        actor: string_at(v, "/creator/display_name"),
        created_at: string_at(v, "/created_on").unwrap_or_default(),
        // A pipeline has no `started_on`, so without this a finished run shows no duration.
        started_at: string_at(v, "/started_on").or_else(|| string_at(v, "/created_on")),
        finished_at: string_at(v, "/completed_on"),
        web_url: match number {
            Some(n) => format!("{web_url}/pipelines/results/{n}"),
            None => format!("{web_url}/pipelines"),
        },
    })
}

/// One pipeline step, as a job; its script commands carry no status, so `steps` stays empty.
pub fn map_step(v: &Value, index: usize) -> Option<Job> {
    let id = string_at(v, "/uuid")?;
    let (status, _) = map_state(v.get("state").unwrap_or(&Value::Null));
    Some(Job {
        id,
        name: string_at(v, "/name").unwrap_or_else(|| format!("Step {}", index + 1)),
        status,
        started_at: string_at(v, "/started_on"),
        finished_at: string_at(v, "/completed_on"),
        web_url: None,
        steps: Vec::new(),
    })
}

/// The worst of a commit's build statuses, or `None` when it has none.
pub fn checks_rollup(statuses: &Value) -> Option<RunStatus> {
    let states: Vec<&str> = statuses
        .get("values")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| str_at(s, "/state"))
        .collect();
    if states.is_empty() {
        return None;
    }
    let any = |s: &str| states.iter().any(|x| *x == s);
    Some(if any("FAILED") {
        RunStatus::Failure
    } else if any("INPROGRESS") {
        RunStatus::Running
    } else if any("STOPPED") {
        RunStatus::Cancelled
    } else if states.iter().all(|s| *s == "SUCCESSFUL") {
        RunStatus::Success
    } else {
        RunStatus::Other
    })
}

fn participant_state(p: &Value) -> ReviewState {
    if p.get("approved").and_then(Value::as_bool) == Some(true) {
        ReviewState::Approved
    } else if str_at(p, "/state") == Some("changes_requested") {
        ReviewState::ChangesRequested
    } else {
        ReviewState::Pending
    }
}

/// The page's `size`, the host's count of all matching pull requests.
fn page_size(page: &Value) -> Option<u64> {
    page.get("size").and_then(Value::as_u64)
}

/// One open pull request, as listed with `participants` and `reviewers` added by `fields`.
pub fn map_pull(v: &Value, viewer: Option<&str>, checks: Option<RunStatus>) -> Option<PullRequest> {
    let number = v.get("id").and_then(Value::as_u64)?;
    let participants: Vec<&Value> = v
        .get("participants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    // A requested reviewer, or anyone who approved or asked for changes.
    let reviewing: Vec<(&Value, ReviewState)> = participants
        .iter()
        .map(|p| (*p, participant_state(p)))
        .filter(|(p, state)| {
            str_at(p, "/role") == Some("REVIEWER") || *state != ReviewState::Pending
        })
        .collect();
    let reviewers: Vec<Reviewer> = reviewing
        .iter()
        .map(|(p, state)| Reviewer {
            login: string_at(p, "/user/display_name")
                .or_else(|| string_at(p, "/user/nickname"))
                .unwrap_or_default(),
            state: *state,
        })
        .collect();
    let review_decision = if reviewers
        .iter()
        .any(|r| r.state == ReviewState::ChangesRequested)
    {
        Some(ReviewState::ChangesRequested)
    } else if reviewers.iter().any(|r| r.state == ReviewState::Approved) {
        Some(ReviewState::Approved)
    } else if reviewers.is_empty() {
        None
    } else {
        Some(ReviewState::Pending)
    };
    let is_mine = viewer.is_some_and(|me| str_at(v, "/author/uuid") == Some(me));
    let review_requested = viewer.is_some_and(|me| {
        reviewing.iter().any(|(p, state)| {
            str_at(p, "/user/uuid") == Some(me)
                && str_at(p, "/role") == Some("REVIEWER")
                && *state == ReviewState::Pending
        })
    });
    Some(PullRequest {
        id: number.to_string(),
        number,
        title: string_at(v, "/title").unwrap_or_default(),
        author: string_at(v, "/author/display_name")
            .or_else(|| string_at(v, "/author/nickname"))
            .unwrap_or_default(),
        draft: v.get("draft").and_then(Value::as_bool).unwrap_or(false),
        source_branch: string_at(v, "/source/branch/name").unwrap_or_default(),
        target_branch: string_at(v, "/destination/branch/name").unwrap_or_default(),
        created_at: string_at(v, "/created_on").unwrap_or_default(),
        updated_at: string_at(v, "/updated_on").unwrap_or_default(),
        web_url: string_at(v, "/links/html/href").unwrap_or_default(),
        review_decision,
        reviewers,
        checks,
        is_mine,
        review_requested,
    })
}

fn strip_links(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| k.as_str() != "links")
                .map(|(k, v)| (k.clone(), strip_links(v)))
                .collect::<Map<_, _>>(),
        ),
        other => other.clone(),
    }
}

/// The body that starts a pipeline like `run`: its target (branch or pull request, selector,
/// and commit) without the response-only links. Custom pipeline variables are not kept.
pub fn rerun_body(run: &Value) -> Option<Value> {
    let target = run.get("target").filter(|t| t.is_object())?;
    Some(json!({ "target": strip_links(target) }))
}

fn token_key(cx: &Cx) -> u64 {
    let mut h = DefaultHasher::new();
    cx.token.value.hash(&mut h);
    h.finish()
}

/// Every page of a paginated list, following `next` only while it stays on the API host.
fn all_values(cx: &Cx, first: &str) -> Result<Vec<Value>, ForgeError> {
    let auth = auth(cx);
    let mut out = Vec::new();
    let mut url = first.to_string();
    for _ in 0..MAX_PAGES {
        let page: Value = cx.http.get_json(&url, Some(&auth), ACCEPT)?;
        if let Some(values) = page.get("values").and_then(Value::as_array) {
            out.extend(values.iter().cloned());
        }
        match str_at(&page, "/next") {
            Some(next) if next.starts_with(API) => url = next.to_string(),
            _ => break,
        }
    }
    Ok(out)
}

impl Bitbucket {
    /// The viewer's uuid, or `None` when the token lacks `read:user:bitbucket` or the call
    /// failed; then no pull request is marked as the viewer's.
    fn viewer(&self, cx: &Cx) -> Option<String> {
        let key = token_key(cx);
        if let Some(v) = VIEWERS.lock().unwrap().get(&key) {
            return v.clone();
        }
        match cx
            .http
            .get_json::<Value>(&format!("{API}/user"), Some(&auth(cx)), ACCEPT)
        {
            Ok(user) => {
                let uuid = string_at(&user, "/uuid");
                VIEWERS.lock().unwrap().insert(key, uuid.clone());
                uuid
            }
            Err(e) if matches!(e.kind, ForgeErrorKind::Forbidden | ForgeErrorKind::NotFound) => {
                VIEWERS.lock().unwrap().insert(key, None);
                None
            }
            Err(_) => None,
        }
    }

    fn checks(&self, cx: &Cx, base: &str, pulls: &[Value]) -> HashMap<u64, Option<RunStatus>> {
        let mut out = HashMap::new();
        for pr in pulls {
            let Some(id) = pr.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let updated = string_at(pr, "/updated_on").unwrap_or_default();
            let key = (base.to_string(), id);
            if let Some((at, checks)) = CHECKS.lock().unwrap().get(&key) {
                if *at == updated {
                    out.insert(id, *checks);
                    continue;
                }
            }
            let url = format!("{base}/pullrequests/{id}/statuses");
            match cx.http.get_json::<Value>(&url, Some(&auth(cx)), ACCEPT) {
                Ok(statuses) => {
                    let checks = checks_rollup(&statuses);
                    CHECKS.lock().unwrap().insert(key, (updated, checks));
                    out.insert(id, checks);
                }
                // The list still shows without its check column.
                Err(_) => {
                    out.insert(id, None);
                }
            }
        }
        // Closed pull requests leave the cache.
        CHECKS
            .lock()
            .unwrap()
            .retain(|(b, id), _| b != base || out.contains_key(id));
        out
    }
}

impl ForgeProvider for Bitbucket {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Bitbucket
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            rerun: true,
            rerun_failed: false,
            cancel: true,
            job_logs: true,
            drafts: true,
            pr_noun: "pull request".into(),
            run_noun: "pipeline".into(),
            min_poll_secs: 30,
            accounts: false,
        }
    }

    fn runs(&self, cx: &Cx, repo: &RepoRef, branch: Option<&str>) -> Result<Vec<Run>, ForgeError> {
        let base = repo_base(repo)?;
        let mut url = format!("{base}/pipelines/?pagelen=20&sort=-created_on");
        if let Some(b) = branch {
            url.push_str(&format!("&target.branch={}", percent_encode(b)));
        }
        let page: Value = cx
            .http
            .get_json(&url, Some(&auth(cx)), ACCEPT)
            .map_err(|e| reword(e, &cx.token.source))?;
        Ok(page
            .get("values")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| map_run(v, &repo.web_url))
            .collect())
    }

    fn jobs(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<Vec<Job>, ForgeError> {
        let url = format!(
            "{}/pipelines/{}/steps/",
            repo_base(repo)?,
            percent_encode(run_id)
        );
        let steps = all_values(cx, &url).map_err(|e| reword(e, &cx.token.source))?;
        Ok(steps
            .iter()
            .enumerate()
            .filter_map(|(i, s)| map_step(s, i))
            .collect())
    }

    fn log(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        run_id: &str,
        job_id: &str,
    ) -> Result<JobLog, ForgeError> {
        let url = format!(
            "{}/pipelines/{}/steps/{}/log",
            repo_base(repo)?,
            percent_encode(run_id),
            percent_encode(job_id)
        );
        match cx.http.get_text_tail(&url, Some(&auth(cx)), &[], LOG_MAX) {
            Ok((text, truncated)) => Ok(JobLog { text, truncated }),
            // A step that hasn't started has no log yet.
            Err(e) if e.kind == ForgeErrorKind::NotFound => Ok(JobLog {
                text: String::new(),
                truncated: false,
            }),
            Err(e) => Err(reword(e, &cx.token.source)),
        }
    }

    fn rerun(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        run_id: &str,
        _failed_only: bool,
    ) -> Result<(), ForgeError> {
        let base = repo_base(repo)?;
        let auth = auth(cx);
        let run: Value = cx
            .http
            .get_json(
                &format!("{base}/pipelines/{}", percent_encode(run_id)),
                Some(&auth),
                ACCEPT,
            )
            .map_err(|e| reword(e, &cx.token.source))?;
        let body = rerun_body(&run)
            .ok_or_else(|| ForgeError::other("This pipeline has no target to run again."))?;
        cx.http
            .post_json(
                &format!("{base}/pipelines/"),
                Some(&auth),
                ACCEPT,
                Some(&body),
            )
            .map_err(|e| reword(e, &cx.token.source))?;
        Ok(())
    }

    fn cancel(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<(), ForgeError> {
        let url = format!(
            "{}/pipelines/{}/stopPipeline",
            repo_base(repo)?,
            percent_encode(run_id)
        );
        cx.http
            .post_json(&url, Some(&auth(cx)), ACCEPT, None)
            .map_err(|e| reword(e, &cx.token.source))?;
        Ok(())
    }

    fn pulls(&self, cx: &Cx, repo: &RepoRef) -> Result<PullList, ForgeError> {
        let base = repo_base(repo)?;
        // The list leaves out participants and reviewers unless `fields` adds them.
        let url = format!(
            "{base}/pullrequests?state=OPEN&pagelen=50&fields=%2Bvalues.participants,%2Bvalues.reviewers"
        );
        let page: Value = cx
            .http
            .get_json(&url, Some(&auth(cx)), ACCEPT)
            .map_err(|e| reword(e, &cx.token.source))?;
        let values: Vec<Value> = page
            .get("values")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let viewer = self.viewer(cx);
        let checks = self.checks(cx, &base, &values);
        let items = values
            .iter()
            .filter_map(|v| {
                let id = v.get("id").and_then(Value::as_u64)?;
                map_pull(v, viewer.as_deref(), checks.get(&id).copied().flatten())
            })
            .collect();
        Ok(PullList {
            items,
            total: page_size(&page),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::http::{Http, map_status_at, name_missing_scopes};
    use crate::forge::types::Token;

    const WEB: &str = "https://bitbucket.org/ws/slug";

    fn state(name: &str, sub: Option<(&str, &str)>) -> Value {
        let mut s = json!({ "name": name });
        if let Some((key, value)) = sub {
            s[key] = json!({ "name": value });
        }
        s
    }

    #[test]
    fn every_state_and_result() {
        use RunStatus as S;
        let table = [
            (state("PENDING", None), S::Queued, "PENDING"),
            (state("READY", None), S::Queued, "READY"),
            (
                state("IN_PROGRESS", Some(("stage", "RUNNING"))),
                S::Running,
                "RUNNING",
            ),
            (state("IN_PROGRESS", None), S::Running, "IN_PROGRESS"),
            (
                state("IN_PROGRESS", Some(("stage", "PAUSED"))),
                S::Waiting,
                "PAUSED",
            ),
            (
                state("IN_PROGRESS", Some(("stage", "HALTED"))),
                S::Waiting,
                "HALTED",
            ),
            (state("PAUSED", None), S::Waiting, "PAUSED"),
            (
                state("COMPLETED", Some(("result", "SUCCESSFUL"))),
                S::Success,
                "SUCCESSFUL",
            ),
            (
                state("COMPLETED", Some(("result", "FAILED"))),
                S::Failure,
                "FAILED",
            ),
            (
                state("COMPLETED", Some(("result", "ERROR"))),
                S::Failure,
                "ERROR",
            ),
            (
                state("COMPLETED", Some(("result", "STOPPED"))),
                S::Cancelled,
                "STOPPED",
            ),
            (
                state("COMPLETED", Some(("result", "EXPIRED"))),
                S::Other,
                "EXPIRED",
            ),
            (
                state("COMPLETED", Some(("result", "NOT_RUN"))),
                S::Skipped,
                "NOT_RUN",
            ),
            (state("COMPLETED", None), S::Other, "COMPLETED"),
            (state("SOMETHING_NEW", None), S::Other, "SOMETHING_NEW"),
            (Value::Null, S::Other, ""),
        ];
        for (s, want, raw) in table {
            assert_eq!(map_state(&s), (want, raw.to_string()), "{s}");
        }
    }

    fn pipeline() -> Value {
        json!({
            "type": "pipeline",
            "uuid": "{11111111-2222-3333-4444-555555555555}",
            "build_number": 418,
            "creator": { "display_name": "Bradley Harris", "uuid": "{me}" },
            "target": {
                "type": "pipeline_ref_target",
                "ref_type": "branch",
                "ref_name": "dev",
                "selector": { "type": "branches", "pattern": "dev" },
                "commit": {
                    "type": "commit",
                    "hash": "1553ef23faec65db19d1cb50557172e057f017a2",
                    "message": "\nFix the export\n\nLonger body",
                    "links": { "self": { "href": "https://api.bitbucket.org/x" } }
                },
                "links": { "self": { "href": "https://api.bitbucket.org/y" } }
            },
            "trigger": { "name": "PUSH", "type": "pipeline_trigger_push" },
            "state": { "name": "COMPLETED", "result": { "name": "SUCCESSFUL" } },
            "created_on": "2026-11-04T22:35:07.475431+00:00",
            "completed_on": "2026-11-04T22:48:21.598244+00:00"
        })
    }

    #[test]
    fn a_pipeline_maps_to_a_run() {
        let r = map_run(&pipeline(), WEB).unwrap();
        assert_eq!(r.id, "{11111111-2222-3333-4444-555555555555}");
        assert_eq!(r.number, Some(418));
        assert_eq!(r.name, "dev");
        assert_eq!(r.title, "Fix the export");
        assert_eq!(r.branch.as_deref(), Some("dev"));
        assert_eq!(
            r.sha.as_deref(),
            Some("1553ef23faec65db19d1cb50557172e057f017a2")
        );
        assert_eq!(r.event.as_deref(), Some("push"));
        assert_eq!(
            (r.status, r.raw_status.as_str()),
            (RunStatus::Success, "SUCCESSFUL")
        );
        assert_eq!(r.actor.as_deref(), Some("Bradley Harris"));
        assert_eq!(r.created_at, "2026-11-04T22:35:07.475431+00:00");
        assert_eq!(r.started_at.as_deref(), Some(r.created_at.as_str()));
        assert_eq!(
            r.finished_at.as_deref(),
            Some("2026-11-04T22:48:21.598244+00:00")
        );
        assert_eq!(
            r.web_url,
            "https://bitbucket.org/ws/slug/pipelines/results/418"
        );
    }

    #[test]
    fn a_default_pipeline_without_a_commit_message() {
        let v = json!({
            "uuid": "{u}",
            "build_number": 7,
            "target": {
                "type": "pipeline_ref_target",
                "ref_name": "main",
                "selector": { "type": "default" },
                "commit": { "hash": "abc" }
            },
            "state": { "name": "IN_PROGRESS", "stage": { "name": "PAUSED" } },
            "created_on": "t"
        });
        let r = map_run(&v, WEB).unwrap();
        assert_eq!((r.name.as_str(), r.title.as_str()), ("Pipeline #7", "main"));
        assert_eq!(r.status, RunStatus::Waiting);
        assert_eq!((r.event, r.actor, r.finished_at), (None, None, None));
        // A pull request pipeline names its source branch instead of a ref.
        let v = json!({
            "uuid": "{p}",
            "target": {
                "type": "pipeline_pullrequest_target",
                "source": "feature",
                "destination": "dev",
                "selector": { "type": "pull-requests", "pattern": "**" }
            },
            "state": { "name": "PENDING" }
        });
        let r = map_run(&v, WEB).unwrap();
        assert_eq!(r.branch.as_deref(), Some("feature"));
        assert_eq!((r.name.as_str(), r.title.as_str()), ("**", "feature"));
        assert_eq!(r.number, None);
        assert_eq!(r.web_url, "https://bitbucket.org/ws/slug/pipelines");
        // As listed, with the pull request's id and title.
        let v = json!({
            "uuid": "{q}",
            "target": {
                "type": "pipeline_pullrequest_target",
                "source": "dev",
                "selector": { "type": "pull-requests", "pattern": "**" },
                "commit": { "hash": "188ff05" },
                "pullrequest": { "id": 122, "title": "Dev" }
            },
            "state": { "name": "IN_PROGRESS" }
        });
        let r = map_run(&v, WEB).unwrap();
        assert_eq!(
            (r.name.as_str(), r.title.as_str()),
            ("Pull request #122", "Dev")
        );
        assert!(map_run(&json!({ "build_number": 1 }), WEB).is_none());
    }

    #[test]
    fn steps_map_to_jobs() {
        let steps = json!([
            {
                "uuid": "{s1}",
                "name": "Build",
                "state": { "name": "COMPLETED", "result": { "name": "SUCCESSFUL" } },
                "started_on": "a",
                "completed_on": "b"
            },
            { "uuid": "{s2}", "state": { "name": "IN_PROGRESS" }, "started_on": "c" },
            {
                "uuid": "{s3}",
                "name": "Deploy",
                "state": { "name": "PENDING" },
                "trigger": { "type": "pipeline_step_trigger_manual" }
            },
            { "name": "no uuid" }
        ]);
        let jobs: Vec<Job> = steps
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter_map(|(i, s)| map_step(s, i))
            .collect();
        assert_eq!(jobs.len(), 3);
        assert_eq!(
            (jobs[0].id.as_str(), jobs[0].name.as_str(), jobs[0].status),
            ("{s1}", "Build", RunStatus::Success)
        );
        assert_eq!(
            (
                jobs[0].started_at.as_deref(),
                jobs[0].finished_at.as_deref()
            ),
            (Some("a"), Some("b"))
        );
        assert_eq!(
            (jobs[1].name.as_str(), jobs[1].status),
            ("Step 2", RunStatus::Running)
        );
        assert_eq!(jobs[2].status, RunStatus::Queued);
        assert!(
            jobs.iter()
                .all(|j| j.steps.is_empty() && j.web_url.is_none())
        );
    }

    fn user(uuid: &str, name: &str) -> Value {
        json!({ "display_name": name, "uuid": uuid, "nickname": name })
    }

    fn participant(uuid: &str, name: &str, role: &str, approved: bool, st: Value) -> Value {
        json!({
            "type": "participant",
            "user": user(uuid, name),
            "role": role,
            "approved": approved,
            "state": st
        })
    }

    fn pull(participants: Vec<Value>) -> Value {
        json!({
            "id": 120,
            "title": "Compare column controls",
            "state": "OPEN",
            "draft": false,
            "author": user("{author}", "Bradley Harris"),
            "source": { "branch": { "name": "uat-changes" } },
            "destination": { "branch": { "name": "dev" } },
            "created_on": "c",
            "updated_on": "u",
            "links": { "html": { "href": "https://bitbucket.org/ws/slug/pull-requests/120" } },
            "participants": participants
        })
    }

    #[test]
    fn participants_in_each_state() {
        let v = pull(vec![
            participant("{a}", "Approver", "REVIEWER", true, json!("approved")),
            participant(
                "{c}",
                "Changer",
                "REVIEWER",
                false,
                json!("changes_requested"),
            ),
            participant("{w}", "Waiting", "REVIEWER", false, Value::Null),
            participant("{p}", "Commenter", "PARTICIPANT", false, Value::Null),
            participant("{q}", "Drive-by", "PARTICIPANT", true, json!("approved")),
        ]);
        let pr = map_pull(&v, Some("{w}"), Some(RunStatus::Success)).unwrap();
        let got: Vec<(&str, ReviewState)> = pr
            .reviewers
            .iter()
            .map(|r| (r.login.as_str(), r.state))
            .collect();
        assert_eq!(
            got,
            vec![
                ("Approver", ReviewState::Approved),
                ("Changer", ReviewState::ChangesRequested),
                ("Waiting", ReviewState::Pending),
                ("Drive-by", ReviewState::Approved),
            ]
        );
        assert_eq!(pr.review_decision, Some(ReviewState::ChangesRequested));
        assert!(pr.review_requested && !pr.is_mine);
        assert_eq!(pr.checks, Some(RunStatus::Success));
        assert_eq!(
            (
                pr.id.as_str(),
                pr.number,
                pr.title.as_str(),
                pr.author.as_str()
            ),
            ("120", 120, "Compare column controls", "Bradley Harris")
        );
        assert_eq!(
            (pr.source_branch.as_str(), pr.target_branch.as_str()),
            ("uat-changes", "dev")
        );
        assert_eq!(
            pr.web_url,
            "https://bitbucket.org/ws/slug/pull-requests/120"
        );

        let v = pull(vec![participant(
            "{a}",
            "A",
            "REVIEWER",
            true,
            json!("approved"),
        )]);
        let pr = map_pull(&v, Some("{author}"), None).unwrap();
        assert_eq!(pr.review_decision, Some(ReviewState::Approved));
        assert!(pr.is_mine && !pr.review_requested);

        // A reviewer who already approved is no longer asked.
        let pr = map_pull(&v, Some("{a}"), None).unwrap();
        assert!(!pr.review_requested);

        let v = pull(vec![participant(
            "{w}",
            "W",
            "REVIEWER",
            false,
            Value::Null,
        )]);
        assert_eq!(
            map_pull(&v, None, None).unwrap().review_decision,
            Some(ReviewState::Pending)
        );
    }

    #[test]
    fn a_draft_with_no_participants_and_no_viewer() {
        let mut v = pull(vec![]);
        v["draft"] = json!(true);
        v.as_object_mut().unwrap().remove("participants");
        let pr = map_pull(&v, None, None).unwrap();
        assert!(pr.draft && !pr.is_mine && !pr.review_requested);
        assert_eq!((pr.review_decision, pr.reviewers.len()), (None, 0));
        assert!(map_pull(&json!({ "title": "no id" }), None, None).is_none());
        // Missing optional fields fall back to empty strings.
        let pr = map_pull(&json!({ "id": 3 }), Some("{me}"), None).unwrap();
        assert_eq!((pr.title.as_str(), pr.source_branch.as_str()), ("", ""));
        assert!(!pr.is_mine && !pr.draft);
    }

    #[test]
    fn build_statuses_roll_up() {
        let s = |states: &[&str]| json!({ "values": states.iter().map(|s| json!({ "state": s })).collect::<Vec<_>>() });
        assert_eq!(checks_rollup(&s(&[])), None);
        assert_eq!(checks_rollup(&json!({})), None);
        assert_eq!(checks_rollup(&s(&["SUCCESSFUL"])), Some(RunStatus::Success));
        assert_eq!(
            checks_rollup(&s(&["SUCCESSFUL", "INPROGRESS"])),
            Some(RunStatus::Running)
        );
        assert_eq!(
            checks_rollup(&s(&["INPROGRESS", "FAILED"])),
            Some(RunStatus::Failure)
        );
        assert_eq!(
            checks_rollup(&s(&["SUCCESSFUL", "STOPPED"])),
            Some(RunStatus::Cancelled)
        );
        assert_eq!(checks_rollup(&s(&["UNKNOWN"])), Some(RunStatus::Other));
    }

    #[test]
    fn rerun_keeps_the_target_without_links() {
        let body = rerun_body(&pipeline()).unwrap();
        let t = &body["target"];
        assert_eq!(t["ref_name"], "dev");
        assert_eq!(t["selector"]["pattern"], "dev");
        assert_eq!(
            t["commit"]["hash"],
            "1553ef23faec65db19d1cb50557172e057f017a2"
        );
        assert!(t.get("links").is_none() && t["commit"].get("links").is_none());
        assert!(rerun_body(&json!({ "uuid": "{u}" })).is_none());
    }

    #[test]
    fn a_forbidden_gcm_token_reads_as_signed_out() {
        let body = r#"{"type": "error", "error": {"message": "Your credentials lack one or more required privilege scopes.", "detail": {"required": ["read:pipeline:bitbucket"], "granted": ["read:repository:bitbucket"]}}}"#;
        let forbidden = name_missing_scopes(map_status_at(403, &[], 0).unwrap(), body);
        let gcm = TokenSource::GitCredential {
            host: HOST.into(),
            username: None,
        };
        let e = reword(forbidden.clone(), &gcm);
        assert_eq!(e.kind, ForgeErrorKind::SignedOut);
        assert!(e.message.contains("Git Credential Manager"));
        assert!(e.message.contains("API token"));
        // The front end reads this word as "the stored token was refused".
        assert!(!e.message.to_ascii_lowercase().contains("rejected"));
        // A 401 from GCM's token gets the same wording.
        let e = reword(map_status_at(401, &[], 0).unwrap(), &gcm);
        assert_eq!(e.kind, ForgeErrorKind::SignedOut);
        assert!(e.message.contains("Git Credential Manager"));

        // The stored API token keeps `forbidden`, naming the missing scope.
        let stored = TokenSource::CredentialManager {
            target: super::super::BITBUCKET_CREDENTIAL.into(),
        };
        let e = reword(forbidden, &stored);
        assert_eq!(e.kind, ForgeErrorKind::Forbidden);
        assert!(
            e.message
                .contains("missing the read:pipeline:bitbucket scope")
        );
        // A 401 with it passes through for `decorate` to word.
        let e = reword(map_status_at(401, &[], 0).unwrap(), &stored);
        assert_eq!(e, map_status_at(401, &[], 0).unwrap());
    }

    fn repo_ref(host: &str, path: &[&str]) -> RepoRef {
        RepoRef {
            provider: ProviderKind::Bitbucket,
            host: host.into(),
            path: path.iter().map(|s| s.to_string()).collect(),
            web_url: format!("https://{host}/{}", path.join("/")),
        }
    }

    #[test]
    fn only_bitbucket_cloud_is_addressed() {
        assert_eq!(
            repo_base(&repo_ref("bitbucket.org", &["ws", "my repo"])).unwrap(),
            "https://api.bitbucket.org/2.0/repositories/ws/my%20repo"
        );
        let e = repo_base(&repo_ref("git.example.com", &["ws", "slug"])).unwrap_err();
        assert_eq!(e.kind, ForgeErrorKind::UnsupportedHost);
        assert!(repo_base(&repo_ref("bitbucket.org", &["ws"])).is_err());
        // Braced uuids keep their braces, encoded.
        assert_eq!(percent_encode("{a-b}"), "%7Ba-b%7D");
    }

    /// Live: pipelines and pull requests for a KEYSYS Bitbucket Cloud repo, with the API token
    /// stored by `bb auth bitbucket`; prints neither the token nor its length.
    /// `cargo test forge::bitbucket -- --ignored`.
    #[test]
    #[ignore]
    fn live_runs_and_pulls() {
        let g = crate::git::test_support::repo("bitbucket-live");
        let token: Token = crate::forge::auth::resolve(
            &g,
            &[TokenSource::CredentialManager {
                target: super::super::BITBUCKET_CREDENTIAL.into(),
            }],
        )
        .expect("store a token with bb auth bitbucket first");
        let http = Http::default();
        let cx = Cx {
            http: &http,
            token: &token,
        };
        let repo = repo_ref(
            "bitbucket.org",
            &["keysys", "cacu-investment-reporting-platform"],
        );
        let runs = Bitbucket.runs(&cx, &repo, None).unwrap();
        assert!(!runs.is_empty());
        assert!(
            runs.iter()
                .all(|r| r.id.starts_with('{') && r.number.is_some())
        );
        let jobs = Bitbucket.jobs(&cx, &repo, &runs[0].id).unwrap();
        assert!(!jobs.is_empty());
        let pulls = Bitbucket.pulls(&cx, &repo).unwrap();
        assert!(
            pulls.total.is_some_and(|t| t >= pulls.items.len() as u64),
            "the list reports a total at least as large as the page"
        );
    }

    #[test]
    fn page_size_is_the_total_when_present() {
        assert_eq!(page_size(&json!({ "size": 60, "values": [] })), Some(60));
        assert_eq!(page_size(&json!({ "values": [] })), None);
    }
}
