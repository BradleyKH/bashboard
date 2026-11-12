//! The Bitbucket Cloud provider (docs/design/ship.md section 3.20), over the 2.0 REST API with a
//! Bearer token. The JSON-to-DTO mapping is pure functions over `serde_json::Value` so it tests
//! without the network.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::thread;

use serde_json::{Map, Value, json};

use super::auth::TokenSource;
use super::remote::percent_encode;
use super::types::{
    Capabilities, ForgeError, ForgeErrorKind, Job, JobLog, ProviderKind, PullList, PullRequest,
    PullChecks, PullChecksQuery, PullState, RepoRef, ReviewState, Reviewer, Run, RunStatus,
};
use super::{Cx, ForgeProvider};
use crate::lock::LockExt;

const API: &str = "https://api.bitbucket.org/2.0";
const HOST: &str = "bitbucket.org";
const LOG_MAX: usize = 1024 * 1024;
const MAX_PAGES: usize = 5;
const ACCEPT: &[(&str, &str)] = &[("Accept", "application/json")];

/// The viewer's uuid per token (by hash, never the token itself), cached once `/user` answers.
static VIEWERS: LazyLock<Mutex<HashMap<u64, Option<String>>>> = LazyLock::new(Default::default);

/// A PR's check rollup by (repo, PR id), with the `updated_on` it was fetched at. A new build
/// status bumps the PR's `updated_on`, so an unchanged PR keeps its rollup without a request,
/// which keeps polling inside Bitbucket's 1,000 requests an hour.
type ChecksCache = HashMap<(String, u64), (String, Option<RunStatus>)>;
static CHECKS: LazyLock<Mutex<ChecksCache>> = LazyLock::new(Default::default);
/// Past this many entries the checks cache starts over. It holds merged and declined pull
/// requests too, so toggling Open does not refetch them.
const CHECKS_MAX: usize = 2000;
/// The pull request fields `map_pull` reads, plus the page's `size`. The default listing is
/// many times larger (links, summaries, full user and repo objects) and takes seconds longer.
const PULL_FIELDS: &str = "size,values.id,values.title,values.state,values.draft,values.created_on,values.updated_on,values.author.uuid,values.author.display_name,values.author.nickname,values.source.branch.name,values.destination.branch.name,values.links.html.href,values.participants.role,values.participants.approved,values.participants.state,values.participants.user.uuid,values.participants.user.display_name,values.participants.user.nickname";
/// Concurrent `/statuses` requests while filling in a list's checks.
const CHECKS_WORKERS: usize = 8;

/// A commit's first message line by (repo, hash). The pipelines list carries only the hash, and
/// a commit never changes, so each one is fetched once per session.
static COMMITS: LazyLock<Mutex<HashMap<(String, String), String>>> =
    LazyLock::new(Default::default);
/// Past this many entries the commit cache starts over rather than growing for the session.
const COMMITS_MAX: usize = 2000;

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
             Bashboard needs a Bitbucket API token; add one in the Accounts tab, or run bb auth bitbucket.",
        );
    }
    e
}

/// `?fields=mainbranch.name` of the repo endpoint.
pub fn map_default_branch(v: &Value) -> Option<String> {
    string_at(v, "/mainbranch/name")
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
    // The pipelines list carries the commit's hash but not its message; `runs` fills the title
    // from the commit (see `untitled_hash`).
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

/// The pull request list URL. The branch filter goes in a BBQL query, since the list has no
/// plain source-branch parameter; a ref name may hold `"` but never `\`, so escaping the quote
/// is enough.
fn pulls_url(base: &str, open_only: bool, branch: Option<&str>) -> String {
    let states = if open_only {
        "state=OPEN"
    } else {
        "state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED"
    };
    let mut url =
        format!("{base}/pullrequests?{states}&sort=-updated_on&pagelen=50&fields={PULL_FIELDS}");
    if let Some(b) = branch {
        let q = format!("source.branch.name=\"{}\"", b.replace('"', "\\\""));
        url.push_str(&format!("&q={}", percent_encode(&q)));
    }
    url
}

/// One pull request, as listed with the `PULL_FIELDS` selection.
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
    let state = match str_at(v, "/state") {
        Some("MERGED") => PullState::Merged,
        Some("DECLINED" | "SUPERSEDED") => PullState::Closed,
        _ => PullState::Open,
    };
    Some(PullRequest {
        id: number.to_string(),
        number,
        title: string_at(v, "/title").unwrap_or_default(),
        author: string_at(v, "/author/display_name")
            .or_else(|| string_at(v, "/author/nickname"))
            .unwrap_or_default(),
        draft: v.get("draft").and_then(Value::as_bool).unwrap_or(false),
        state,
        source_branch: string_at(v, "/source/branch/name").unwrap_or_default(),
        target_branch: string_at(v, "/destination/branch/name").unwrap_or_default(),
        created_at: string_at(v, "/created_on").unwrap_or_default(),
        updated_at: string_at(v, "/updated_on").unwrap_or_default(),
        web_url: string_at(v, "/links/html/href").unwrap_or_default(),
        review_decision,
        reviewers,
        checks,
        checks_pending: false,
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

/// The commit hash whose message would title `run`: a pipeline with no commit message and no pull
/// request title, which `map_run` would otherwise title with its branch name.
pub fn untitled_hash(run: &Value) -> Option<&str> {
    let target = run.get("target")?;
    if str_at(target, "/commit/message").is_some() || str_at(target, "/pullrequest/title").is_some()
    {
        return None;
    }
    str_at(target, "/commit/hash")
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
    /// The viewer's uuid, which marks the pull requests that are the viewer's or await their
    /// review. `read:user:bitbucket` is a required scope, so a refusal fails the list with a
    /// message naming it rather than quietly dropping the Yours and Review requested groups.
    /// Only a success is cached, so a token replaced after a failure is asked again.
    fn viewer(&self, cx: &Cx) -> Result<Option<String>, ForgeError> {
        let key = token_key(cx);
        if let Some(v) = VIEWERS.lock_or_recover().get(&key) {
            return Ok(v.clone());
        }
        let user = cx
            .http
            .get_json::<Value>(&format!("{API}/user"), Some(&auth(cx)), ACCEPT)
            .map_err(|e| reword(e, &cx.token.source))?;
        let uuid = string_at(&user, "/uuid");
        VIEWERS.lock_or_recover().insert(key, uuid.clone());
        Ok(uuid)
    }

    /// First message lines for the commits that title `runs`, from the cache or one request per
    /// hash not yet seen. A failed request leaves its runs titled by branch until the next poll.
    fn commit_titles(&self, cx: &Cx, base: &str, runs: &[Value]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        for hash in runs.iter().filter_map(untitled_hash) {
            if out.contains_key(hash) {
                continue;
            }
            let key = (base.to_string(), hash.to_string());
            if let Some(title) = COMMITS.lock_or_recover().get(&key) {
                out.insert(hash.to_string(), title.clone());
                continue;
            }
            let url = format!("{base}/commit/{}?fields=message", percent_encode(hash));
            let Ok(commit) = cx.http.get_json::<Value>(&url, Some(&auth(cx)), ACCEPT) else {
                continue;
            };
            let Some(title) = str_at(&commit, "/message").and_then(first_line) else {
                continue;
            };
            let mut cache = COMMITS.lock_or_recover();
            if cache.len() >= COMMITS_MAX {
                cache.clear();
            }
            cache.insert(key, title.clone());
            out.insert(hash.to_string(), title);
        }
        out
    }

    /// Cached checks for the listed pull requests whose `updated_on` has not moved. Those
    /// missing are fetched later by `pull_checks`, so the list shows without waiting on them.
    fn cached_checks(base: &str, pulls: &[Value]) -> HashMap<u64, Option<RunStatus>> {
        let cache = CHECKS.lock_or_recover();
        pulls
            .iter()
            .filter_map(|pr| {
                let id = pr.get("id").and_then(Value::as_u64)?;
                let updated = str_at(pr, "/updated_on").unwrap_or_default();
                match cache.get(&(base.to_string(), id)) {
                    Some((at, checks)) if at == updated => Some((id, *checks)),
                    _ => None,
                }
            })
            .collect()
    }

    /// One pull request's checks from `/statuses`, cached against `updated`. A failed request
    /// answers `None` and stays uncached, so the next list asks again.
    fn fetch_checks(cx: &Cx, base: &str, id: u64, updated: &str) -> Option<RunStatus> {
        let url = format!("{base}/pullrequests/{id}/statuses");
        let statuses = cx.http.get_json::<Value>(&url, Some(&auth(cx)), ACCEPT).ok()?;
        let checks = checks_rollup(&statuses);
        let mut cache = CHECKS.lock_or_recover();
        if cache.len() >= CHECKS_MAX {
            cache.clear();
        }
        cache.insert((base.to_string(), id), (updated.to_string(), checks));
        checks
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
        let values: &[Value] = page
            .get("values")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice);
        let titles = self.commit_titles(cx, &base, values);
        Ok(values
            .iter()
            .filter_map(|v| {
                let mut run = map_run(v, &repo.web_url)?;
                if let Some(title) = untitled_hash(v).and_then(|h| titles.get(h)) {
                    run.title = title.clone();
                }
                Some(run)
            })
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

    fn pulls(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        open_only: bool,
        branch: Option<&str>,
    ) -> Result<PullList, ForgeError> {
        let base = repo_base(repo)?;
        let url = pulls_url(&base, open_only, branch);
        let page: Value = cx
            .http
            .get_json(&url, Some(&auth(cx)), ACCEPT)
            .map_err(|e| reword(e, &cx.token.source))?;
        let values: Vec<Value> = page
            .get("values")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let viewer = self.viewer(cx)?;
        let cached = Self::cached_checks(&base, &values);
        let items = values
            .iter()
            .filter_map(|v| {
                let id = v.get("id").and_then(Value::as_u64)?;
                let mut pull = map_pull(v, viewer.as_deref(), cached.get(&id).copied().flatten())?;
                // A merged or declined pull request's build is history, not worth a request each.
                pull.checks_pending = pull.state == PullState::Open && !cached.contains_key(&id);
                Some(pull)
            })
            .collect();
        Ok(PullList {
            items,
            total: page_size(&page),
        })
    }

    fn pull_checks(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        pulls: &[PullChecksQuery],
    ) -> Result<Vec<PullChecks>, ForgeError> {
        let base = repo_base(repo)?;
        // One request per pull request, so they run a few at a time rather than in series.
        let next = AtomicUsize::new(0);
        let found = Mutex::new(Vec::with_capacity(pulls.len()));
        thread::scope(|scope| {
            for _ in 0..CHECKS_WORKERS.min(pulls.len()) {
                scope.spawn(|| {
                    while let Some(q) = pulls.get(next.fetch_add(1, Ordering::Relaxed)) {
                        let Ok(id) = q.id.parse::<u64>() else { continue };
                        let checks = Self::fetch_checks(cx, &base, id, &q.updated_at);
                        found.lock_or_recover().push(PullChecks {
                            id: q.id.clone(),
                            checks,
                        });
                    }
                });
            }
        });
        Ok(found.into_inner().unwrap())
    }

    fn default_branch(&self, cx: &Cx, repo: &RepoRef) -> Result<Option<String>, ForgeError> {
        let url = format!("{}?fields=mainbranch.name", repo_base(repo)?);
        let v: Value = cx
            .http
            .get_json(&url, Some(&auth(cx)), ACCEPT)
            .map_err(|e| reword(e, &cx.token.source))?;
        Ok(map_default_branch(&v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::http::{Http, map_status_at, name_missing_scopes};
    use crate::forge::types::Token;

    #[test]
    fn pulls_url_filters_by_source_branch_only_when_asked() {
        let all = pulls_url("https://x/r", true, None);
        assert!(all.starts_with("https://x/r/pullrequests?state=OPEN&sort="));
        assert!(!all.contains("&q="));
        let mine = pulls_url("https://x/r", false, Some("feat/a\"b"));
        assert!(mine.contains("state=DECLINED"));
        assert!(mine.ends_with("&q=source.branch.name%3D%22feat%2Fa%5C%22b%22"));
    }

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
    fn only_a_run_titled_by_its_branch_needs_its_commit() {
        assert_eq!(untitled_hash(&pipeline()), None);
        let branch = json!({ "target": { "ref_name": "dev", "commit": { "hash": "abc" } } });
        assert_eq!(untitled_hash(&branch), Some("abc"));
        let pull = json!({
            "target": { "commit": { "hash": "abc" }, "pullrequest": { "id": 1, "title": "Dev" } }
        });
        assert_eq!(untitled_hash(&pull), None);
        assert_eq!(
            untitled_hash(&json!({ "target": { "ref_name": "dev" } })),
            None
        );
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
            path: None,
        };
        let e = reword(forbidden.clone(), &gcm);
        assert_eq!(e.kind, ForgeErrorKind::SignedOut);
        assert!(e.message.contains("Git Credential Manager"));
        assert!(e.message.contains("API token"));
        assert!(e.message.contains("Accounts tab"));
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
    fn default_branch_from_mainbranch() {
        assert_eq!(
            map_default_branch(&json!({"mainbranch": {"name": "develop"}})).as_deref(),
            Some("develop")
        );
        assert_eq!(map_default_branch(&json!({"mainbranch": null})), None);
        assert_eq!(map_default_branch(&json!({})), None);
    }

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
        let pulls = Bitbucket.pulls(&cx, &repo, true, None).unwrap();
        assert!(
            pulls.total.is_some_and(|t| t >= pulls.items.len() as u64),
            "the list reports a total at least as large as the page"
        );
        // Every state, timing the list apart from the checks it leaves pending.
        let started = std::time::Instant::now();
        let all = Bitbucket.pulls(&cx, &repo, false, None).unwrap();
        let listed = started.elapsed();
        assert!(
            all.items
                .iter()
                .all(|p| !p.author.is_empty() && !p.web_url.is_empty() && !p.updated_at.is_empty()),
            "PULL_FIELDS keeps what the row shows"
        );
        assert!(
            all.items
                .iter()
                .all(|p| p.state == PullState::Open || !p.checks_pending),
            "only open pull requests wait on checks"
        );
        let queries: Vec<PullChecksQuery> = all
            .items
            .iter()
            .filter(|p| p.checks_pending)
            .map(|p| PullChecksQuery {
                id: p.id.clone(),
                updated_at: p.updated_at.clone(),
            })
            .collect();
        let started = std::time::Instant::now();
        let found = Bitbucket.pull_checks(&cx, &repo, &queries).unwrap();
        let checked = started.elapsed();
        assert_eq!(found.len(), queries.len(), "one answer per pending pull request");
        eprintln!(
            "{} pull requests listed in {listed:?}, {} pending checks fetched in {checked:?}",
            all.items.len(),
            queries.len()
        );
        let again = Bitbucket.pulls(&cx, &repo, false, None).unwrap();
        assert!(
            again.items.iter().all(|p| !p.checks_pending),
            "a second list finds every rollup cached"
        );
        // The overview through a remote target, as the Overview tab asks for it.
        let home = std::env::var("USERPROFILE").expect("USERPROFILE");
        let git = g.at(home.into());
        let state = super::super::ForgeState::default();
        let target = "remote:bitbucket.org/keysys/cacu-investment-reporting-platform";
        let r = state
            .cached(target, || {
                super::super::resolve_remote(
                    target.trim_start_matches(super::super::REMOTE_PREFIX),
                    &Default::default(),
                    "",
                )
            })
            .unwrap();
        let started = std::time::Instant::now();
        let o = super::super::overview(&state, &git, &r).unwrap();
        let cold = started.elapsed();
        assert_eq!(o.repo.branch, None);
        assert!(o.default_branch.is_some(), "the host names a main branch");
        assert!(!o.runs.is_empty() && o.runs.len() <= 20);
        assert!(
            o.pulls
                .total
                .is_some_and(|t| t >= o.pulls.items.len() as u64)
        );
        let started = std::time::Instant::now();
        super::super::overview(&state, &git, &r).unwrap();
        eprintln!(
            "overview: {} runs, {} open pull requests, default branch found, {cold:?} cold, {:?} warm",
            o.runs.len(),
            o.pulls.items.len(),
            started.elapsed()
        );
    }

    #[test]
    fn maps_each_pull_state() {
        let cases = [
            ("OPEN", PullState::Open),
            ("MERGED", PullState::Merged),
            ("DECLINED", PullState::Closed),
            ("SUPERSEDED", PullState::Closed),
        ];
        for (state, want) in cases {
            let mut v = pull(vec![]);
            v["state"] = json!(state);
            assert_eq!(map_pull(&v, None, None).unwrap().state, want, "{state}");
        }
    }

    #[test]
    fn page_size_is_the_total_when_present() {
        assert_eq!(page_size(&json!({ "size": 60, "values": [] })), Some(60));
        assert_eq!(page_size(&json!({ "values": [] })), None);
    }
}
