//! The Forge pane's backend: a repo's CI runs and open pull requests from its code host
//! (docs/design.md section 3.20).
//!
//! Every host sits behind `ForgeProvider` and returns the shapes in `types`, so the front end
//! only sees a few capability flags. The commands resolve the repo from its git remote, pick
//! the provider, find a token (`auth`), and call the trait on a blocking thread; the trait's
//! methods are blocking for that reason, which also keeps it object safe without an async
//! trait crate.

pub mod auth;
pub mod bitbucket;
pub mod github;
pub mod http;
pub mod remote;
pub mod types;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::git::{self, Git};
use crate::settings::SettingsState;
use auth::{TokenCache, TokenSource};
use http::Http;
use types::{
    AccountSource, Capabilities, ForgeError, ForgeErrorKind, ForgeRepo, Job, JobLog, ProviderKind,
    PullChecks, PullChecksQuery, PullList, RepoRef, Run, Token,
};

const REPO_TTL: Duration = Duration::from_secs(15);
const MAX_RUNS: usize = 20;
const MAX_PULLS: usize = 50;
const GH_INSTALL_URL: &str = "https://cli.github.com";
const BITBUCKET_TOKEN_URL: &str = "https://id.atlassian.com/manage-profile/security/api-tokens";
pub const BITBUCKET_CREDENTIAL: &str = "bashboard:bitbucket.org";

/// What a provider call gets besides the repo: the shared client and the resolved token.
pub struct Cx<'a> {
    pub http: &'a Http,
    pub token: &'a Token,
}

pub trait ForgeProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn capabilities(&self) -> Capabilities;
    fn runs(&self, cx: &Cx, repo: &RepoRef, branch: Option<&str>) -> Result<Vec<Run>, ForgeError>;
    fn jobs(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<Vec<Job>, ForgeError>;
    fn log(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        run_id: &str,
        job_id: &str,
    ) -> Result<JobLog, ForgeError>;
    fn rerun(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        run_id: &str,
        failed_only: bool,
    ) -> Result<(), ForgeError>;
    fn cancel(&self, cx: &Cx, repo: &RepoRef, run_id: &str) -> Result<(), ForgeError>;
    /// The most recently updated pull requests: open ones only, or those in any state.
    fn pulls(&self, cx: &Cx, repo: &RepoRef, open_only: bool) -> Result<PullList, ForgeError>;
    /// Checks for the pull requests `pulls` left marked `checks_pending`. A host whose list
    /// already carries them never marks one, so the default answers nothing.
    fn pull_checks(
        &self,
        _cx: &Cx,
        _repo: &RepoRef,
        _pulls: &[PullChecksQuery],
    ) -> Result<Vec<PullChecks>, ForgeError> {
        Ok(Vec::new())
    }
}

static GITHUB: github::GitHub = github::GitHub;
static BITBUCKET: bitbucket::Bitbucket = bitbucket::Bitbucket;

/// `None` for the hosts the remote parser knows but no provider serves yet.
pub fn provider(kind: ProviderKind) -> Option<&'static dyn ForgeProvider> {
    match kind {
        ProviderKind::Github => Some(&GITHUB),
        ProviderKind::Bitbucket => Some(&BITBUCKET),
        ProviderKind::Gitlab | ProviderKind::AzureDevOps => None,
    }
}

/// Where each provider's token comes from, in order.
pub fn token_sources(kind: ProviderKind, host: &str, account: Option<&str>) -> Vec<TokenSource> {
    let git_credential = TokenSource::GitCredential {
        host: host.to_string(),
        username: account.map(str::to_string),
    };
    match kind {
        ProviderKind::Github => {
            let mut args = vec![
                "auth".to_string(),
                "token".into(),
                "--hostname".into(),
                host.into(),
            ];
            if let Some(user) = account {
                args.extend(["--user".to_string(), user.to_string()]);
            }
            vec![
                TokenSource::Cli {
                    program: "gh".into(),
                    args,
                },
                git_credential,
            ]
        }
        ProviderKind::Bitbucket => vec![
            TokenSource::CredentialManager {
                target: BITBUCKET_CREDENTIAL.into(),
            },
            git_credential,
        ],
        ProviderKind::Gitlab | ProviderKind::AzureDevOps => vec![git_credential],
    }
}

/// A repo resolved from its remote, with the account its token is fetched for.
#[derive(Debug, Clone)]
struct Resolved {
    repo: RepoRef,
    branch: Option<String>,
    account: Option<String>,
    account_source: AccountSource,
    accounts: Vec<String>,
}

#[derive(Default)]
pub struct ForgeState {
    http: Http,
    tokens: TokenCache,
    repos: Mutex<HashMap<String, (Instant, Resolved)>>,
}

fn not_a_repo() -> ForgeError {
    ForgeError::new(ForgeErrorKind::NotARepo, "This folder isn't in a git repo.")
}

fn open_git(settings: &SettingsState, root: &str) -> Result<Git, ForgeError> {
    if !crate::files::normalize(root).is_ok_and(|p| p.is_dir()) {
        return Err(not_a_repo());
    }
    Git::open(settings, root).map_err(ForgeError::other)
}

fn git_value(git: &Git, args: &[&str]) -> Option<String> {
    let out = git.read(args).ok()?;
    let value = Git::ok(out).ok()?;
    (!value.is_empty()).then_some(value)
}

/// The host name without a port, for `hosts.yml` and `gh --hostname`.
fn bare_host(host: &str) -> &str {
    host.split(':').next().unwrap_or(host)
}

fn resolve_repo(git: &Git, hosts: &HashMap<String, ProviderKind>) -> Result<Resolved, ForgeError> {
    if !git
        .read(["rev-parse", "--git-dir"])
        .map_err(ForgeError::other)?
        .ok
    {
        return Err(not_a_repo());
    }
    // `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`, which fails before the first
    // commit; it exits nonzero when HEAD is detached.
    let branch = git_value(git, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let upstream_remote = branch
        .as_deref()
        .and_then(|b| git_value(git, &["config", "--get", &format!("branch.{b}.remote")]))
        .filter(|r| r != ".");
    let remote = match upstream_remote {
        Some(r) => r,
        None => {
            let remotes: Vec<String> = git_value(git, &["remote"])
                .unwrap_or_default()
                .lines()
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_string)
                .collect();
            git::publish_remote(&remotes)
                .map(str::to_string)
                .ok_or_else(|| {
                    ForgeError::new(ForgeErrorKind::NoRemote, "This repo has no remote.")
                })?
        }
    };
    let url = git_value(git, &["remote", "get-url", &remote]).ok_or_else(|| {
        ForgeError::new(
            ForgeErrorKind::NoRemote,
            format!("The remote {remote} has no URL."),
        )
    })?;
    // The URL itself stays out of messages: an https remote can carry a password.
    let parsed = remote::parse_remote(&url).ok_or_else(|| {
        ForgeError::new(
            ForgeErrorKind::UnsupportedHost,
            format!("The remote {remote} has a URL Bashboard can't read."),
        )
    })?;
    let hosts_yml = remote::read_gh_hosts_yml().unwrap_or_default();
    let gh_hosts = remote::parse_gh_hosts(&hosts_yml);
    // The repo never resolves for these, so `url` is how the notice learns the host to name.
    let unsupported = |host: &str, message: String| ForgeError {
        url: Some(format!("https://{host}")),
        ..ForgeError::new(ForgeErrorKind::UnsupportedHost, message)
    };
    let repo = remote::classify(&parsed, hosts, &gh_hosts).ok_or_else(|| {
        unsupported(
            &parsed.host,
            format!(
                "{} isn't a code host Bashboard recognizes. Name its provider in the forge.hosts setting.",
                parsed.host
            ),
        )
    })?;
    if provider(repo.provider).is_none() {
        return Err(unsupported(
            &repo.host,
            format!("{} isn't supported yet", repo.provider.display_name()),
        ));
    }
    let (accounts, active) = match repo.provider {
        ProviderKind::Github => auth::gh_accounts(&hosts_yml, bare_host(&repo.host)),
        _ => (Vec::new(), None),
    };
    let repo_user = git_value(git, &["config", "--get", "credential.username"]).or_else(|| {
        git_value(
            git,
            &[
                "config",
                "--get-urlmatch",
                "credential.username",
                &format!("https://{}/", repo.host),
            ],
        )
    });
    let (account, account_source) = auth::choose_account(
        repo_user.as_deref(),
        parsed.user.as_deref(),
        &accounts,
        active.as_deref(),
    );
    Ok(Resolved {
        repo,
        branch,
        account,
        account_source,
        accounts,
    })
}

fn forge_hosts(settings: &SettingsState) -> HashMap<String, ProviderKind> {
    settings
        .current()
        .forge_hosts()
        .into_iter()
        .filter_map(|(host, kind)| {
            Some((
                host.to_ascii_lowercase(),
                ProviderKind::from_setting(&kind)?,
            ))
        })
        .collect()
}

impl ForgeState {
    fn resolved(
        &self,
        git: &Git,
        settings: &SettingsState,
        root: &str,
    ) -> Result<Resolved, ForgeError> {
        if let Some((at, r)) = self.repos.lock().unwrap().get(root) {
            if at.elapsed() < REPO_TTL {
                return Ok(r.clone());
            }
        }
        let r = resolve_repo(git, &forge_hosts(settings))?;
        self.repos
            .lock()
            .unwrap()
            .insert(root.to_string(), (Instant::now(), r.clone()));
        Ok(r)
    }

    fn token(&self, git: &Git, r: &Resolved, fresh: bool) -> Result<Token, ForgeError> {
        let (kind, host, account) = (
            r.repo.provider,
            bare_host(&r.repo.host),
            r.account.as_deref(),
        );
        if !fresh {
            if let Some(t) = self.tokens.get(kind, host, account) {
                return Ok(t);
            }
        }
        let token = auth::resolve(git, &token_sources(kind, &r.repo.host, account))?;
        self.tokens.put(kind, host, account, token.clone());
        Ok(token)
    }
}

/// Turns a final `signedOut` into the notice's next step, and points a GitHub `notFound` on a
/// host with several accounts at the account picker.
fn decorate(mut e: ForgeError, r: &Resolved, token: Option<&Token>) -> ForgeError {
    let host = bare_host(&r.repo.host);
    match (e.kind, r.repo.provider) {
        (ForgeErrorKind::SignedOut, ProviderKind::Github) => match auth::locate_program("gh") {
            Some(gh) => {
                // A gh installed after Bashboard started is not on a new pane's PATH yet.
                let program = if auth::gh_on_path() {
                    "gh".to_string()
                } else {
                    gh.to_string_lossy().into_owned()
                };
                e.message = format!(
                    "Sign in to GitHub CLI for {host} to see this repo's runs and pull requests."
                );
                e.sign_in = Some(vec![
                    program,
                    "auth".into(),
                    "login".into(),
                    "--hostname".into(),
                    host.into(),
                    "--web".into(),
                ]);
            }
            None => {
                e.kind = ForgeErrorKind::NotInstalled;
                e.message = "GitHub CLI isn't installed. Install it, then sign in.".into();
                e.url = Some(GH_INSTALL_URL.into());
                e.sign_in = Some(
                    ["winget", "install", "--id", "GitHub.cli", "-e"]
                        .map(String::from)
                        .to_vec(),
                );
            }
        },
        (ForgeErrorKind::SignedOut, ProviderKind::Bitbucket) => {
            match token.map(|t| &t.source) {
                None => {
                    e.message = "No Bitbucket API token is stored. Run bb auth bitbucket to add one.".into()
                }
                Some(TokenSource::CredentialManager { .. }) => {
                    e.message = "The stored Bitbucket API token was rejected (it may have expired or lack a scope). Run bb auth bitbucket to replace it.".into()
                }
                // A Git Credential Manager token's message comes from the provider.
                Some(_) => {}
            }
            e.url = Some(BITBUCKET_TOKEN_URL.into());
            e.sign_in = Some(["bb", "auth", "bitbucket"].map(String::from).to_vec());
        }
        (ForgeErrorKind::NotFound, ProviderKind::Github) if r.accounts.len() > 1 => {
            e.message = format!(
                "GitHub could not find this repo as {}. It may belong to another account; pick one from the account menu.",
                r.account.as_deref().unwrap_or("the active account")
            );
        }
        _ => {}
    }
    e
}

/// Whether a refused call is worth repeating after re-resolving the token: only a `forbidden`
/// result, and only when the new token differs from the one that failed. A user who fixed a
/// missing scope by storing a better token gets through, while an ordinary 403 costs no extra
/// request and a mutating call never repeats with the token that was just refused.
fn retry_after_refresh(kind: ForgeErrorKind, failed: &Token, resolved: &Token) -> bool {
    kind == ForgeErrorKind::Forbidden && failed.value != resolved.value
}

/// Resolves the repo, provider, and token, then runs `call`. A cached token that comes back
/// `signedOut` is dropped and resolved once more before the error stands; one that comes back
/// `forbidden` is dropped too, but the call repeats only if the re-resolved token differs.
fn with_provider<T>(
    app: &AppHandle,
    root: &str,
    call: impl Fn(&dyn ForgeProvider, &Cx, &RepoRef) -> Result<T, ForgeError>,
) -> Result<T, ForgeError> {
    let settings = app.state::<SettingsState>();
    let state = app.state::<ForgeState>();
    let git = open_git(&settings, root)?;
    let r = state.resolved(&git, &settings, root)?;
    let p = provider(r.repo.provider).ok_or_else(|| ForgeError::other("no provider"))?;
    let mut fresh = false;
    let mut refreshed: Option<Token> = None;
    loop {
        let token = match refreshed.take() {
            Some(t) => t,
            None => match state.token(&git, &r, fresh) {
                Ok(t) => t,
                Err(e) => return Err(decorate(e, &r, None)),
            },
        };
        match call(
            p,
            &Cx {
                http: &state.http,
                token: &token,
            },
            &r.repo,
        ) {
            Err(e) if e.kind == ForgeErrorKind::SignedOut => {
                let host = bare_host(&r.repo.host);
                state
                    .tokens
                    .drop_one(r.repo.provider, host, r.account.as_deref());
                if fresh {
                    return Err(decorate(e, &r, Some(&token)));
                }
                fresh = true;
            }
            Err(e) if e.kind == ForgeErrorKind::Forbidden && !fresh => {
                let host = bare_host(&r.repo.host);
                state
                    .tokens
                    .drop_one(r.repo.provider, host, r.account.as_deref());
                // A failed re-resolve leaves the original 403 as the answer.
                match state.token(&git, &r, true) {
                    Ok(next) if retry_after_refresh(e.kind, &token, &next) => {
                        refreshed = Some(next);
                        fresh = true;
                    }
                    _ => return Err(decorate(e, &r, Some(&token))),
                }
            }
            Err(e) => return Err(decorate(e, &r, Some(&token))),
            Ok(v) => return Ok(v),
        }
    }
}

fn forge_repo_of(r: &Resolved) -> ForgeRepo {
    let path = &r.repo.path;
    let (owner, name) = match path.split_last() {
        Some((name, owner)) => (owner.join("/"), name.clone()),
        None => (String::new(), String::new()),
    };
    let capabilities = provider(r.repo.provider)
        .map(|p| p.capabilities())
        .expect("resolve_repo only returns served providers");
    ForgeRepo {
        provider: r.repo.provider,
        host: r.repo.host.clone(),
        owner,
        name,
        web_url: r.repo.web_url.clone(),
        branch: r.branch.clone(),
        capabilities,
        account: r.account.clone(),
        account_source: r.account_source,
        accounts: r.accounts.clone(),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ForgeError> + Send + 'static,
) -> Result<T, ForgeError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| ForgeError::other(e.to_string()))?
}

#[tauri::command]
pub async fn forge_repo(app: AppHandle, root: String) -> Result<ForgeRepo, ForgeError> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let git = open_git(&settings, &root)?;
        let r = app.state::<ForgeState>().resolved(&git, &settings, &root)?;
        Ok(forge_repo_of(&r))
    })
    .await
}

/// Newest first, at most 20; `branch` `None` means every branch.
#[tauri::command]
pub async fn forge_runs(
    app: AppHandle,
    root: String,
    branch: Option<String>,
) -> Result<Vec<Run>, ForgeError> {
    blocking(move || {
        let mut runs = with_provider(&app, &root, |p, cx, repo| {
            p.runs(cx, repo, branch.as_deref())
        })?;
        runs.truncate(MAX_RUNS);
        Ok(runs)
    })
    .await
}

#[tauri::command]
pub async fn forge_jobs(
    app: AppHandle,
    root: String,
    run_id: String,
) -> Result<Vec<Job>, ForgeError> {
    blocking(move || with_provider(&app, &root, |p, cx, repo| p.jobs(cx, repo, &run_id))).await
}

#[tauri::command]
pub async fn forge_log(
    app: AppHandle,
    root: String,
    run_id: String,
    job_id: String,
) -> Result<JobLog, ForgeError> {
    blocking(move || with_provider(&app, &root, |p, cx, repo| p.log(cx, repo, &run_id, &job_id)))
        .await
}

#[tauri::command]
pub async fn forge_rerun(
    app: AppHandle,
    root: String,
    run_id: String,
    failed_only: bool,
) -> Result<(), ForgeError> {
    blocking(move || {
        with_provider(&app, &root, |p, cx, repo| {
            p.rerun(cx, repo, &run_id, failed_only)
        })
    })
    .await
}

#[tauri::command]
pub async fn forge_cancel(app: AppHandle, root: String, run_id: String) -> Result<(), ForgeError> {
    blocking(move || with_provider(&app, &root, |p, cx, repo| p.cancel(cx, repo, &run_id))).await
}

/// Pull requests, at most 50, with the host's count of all that match: open ones unless
/// `open_only` is false, which takes every state.
#[tauri::command]
pub async fn forge_pulls(
    app: AppHandle,
    root: String,
    open_only: Option<bool>,
) -> Result<PullList, ForgeError> {
    let open_only = open_only.unwrap_or(true);
    blocking(move || {
        let mut pulls = with_provider(&app, &root, |p, cx, repo| p.pulls(cx, repo, open_only))?;
        pulls.items.truncate(MAX_PULLS);
        Ok(pulls)
    })
    .await
}

/// Checks for the pull requests a `forge_pulls` reply marked `checksPending`, at most 50.
#[tauri::command]
pub async fn forge_pull_checks(
    app: AppHandle,
    root: String,
    mut pulls: Vec<PullChecksQuery>,
) -> Result<Vec<PullChecks>, ForgeError> {
    pulls.truncate(MAX_PULLS);
    blocking(move || with_provider(&app, &root, |p, cx, repo| p.pull_checks(cx, repo, &pulls))).await
}

/// Sets the repo's `credential.username`, which picks both the token the pane uses and the
/// account Git Credential Manager pushes as, then returns the re-resolved repo.
#[tauri::command]
pub async fn forge_set_account(
    app: AppHandle,
    root: String,
    user: String,
) -> Result<ForgeRepo, ForgeError> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let state = app.state::<ForgeState>();
        let git = open_git(&settings, &root)?;
        let r = state.resolved(&git, &settings, &root)?;
        if !r.accounts.iter().any(|a| a == &user) {
            return Err(ForgeError::other(format!(
                "{user} isn't signed in to GitHub CLI for {}.",
                bare_host(&r.repo.host)
            )));
        }
        let out = git
            .write(["config", "--local", "credential.username", user.as_str()])
            .map_err(ForgeError::other)?;
        Git::ok(out).map_err(ForgeError::other)?;
        state.repos.lock().unwrap().remove(&root);
        state
            .tokens
            .drop_host(r.repo.provider, bare_host(&r.repo.host));
        let r = state.resolved(&git, &settings, &root)?;
        Ok(forge_repo_of(&r))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_and_capabilities() {
        assert!(provider(ProviderKind::Gitlab).is_none());
        assert!(provider(ProviderKind::AzureDevOps).is_none());
        let gh = provider(ProviderKind::Github).unwrap();
        assert_eq!(gh.kind(), ProviderKind::Github);
        let c = gh.capabilities();
        assert!(c.rerun && c.rerun_failed && c.cancel && c.job_logs && c.drafts && c.accounts);
        assert_eq!(
            (c.pr_noun.as_str(), c.run_noun.as_str(), c.min_poll_secs),
            ("pull request", "workflow run", 10)
        );
        let bb = provider(ProviderKind::Bitbucket).unwrap();
        let c = bb.capabilities();
        assert!(c.rerun && !c.rerun_failed && c.cancel && c.job_logs && c.drafts && !c.accounts);
        assert_eq!((c.run_noun.as_str(), c.min_poll_secs), ("pipeline", 30));
    }

    #[test]
    fn forbidden_retries_only_with_a_different_token() {
        let token = |v: &str| Token {
            value: v.into(),
            source: TokenSource::CredentialManager {
                target: BITBUCKET_CREDENTIAL.into(),
            },
            expires: None,
        };
        let (old, new) = (token("old"), token("new"));
        assert!(retry_after_refresh(ForgeErrorKind::Forbidden, &old, &new));
        assert!(!retry_after_refresh(
            ForgeErrorKind::Forbidden,
            &old,
            &old.clone()
        ));
        for kind in [
            ForgeErrorKind::SignedOut,
            ForgeErrorKind::NotFound,
            ForgeErrorKind::RateLimited,
            ForgeErrorKind::Other,
        ] {
            assert!(!retry_after_refresh(kind, &old, &new));
        }
    }

    #[test]
    fn token_sources_per_provider() {
        let gh = token_sources(ProviderKind::Github, "github.com", Some("bob"));
        assert_eq!(
            gh[0],
            TokenSource::Cli {
                program: "gh".into(),
                args: ["auth", "token", "--hostname", "github.com", "--user", "bob"]
                    .map(String::from)
                    .to_vec()
            }
        );
        assert_eq!(
            gh[1],
            TokenSource::GitCredential {
                host: "github.com".into(),
                username: Some("bob".into())
            }
        );
        let bb = token_sources(ProviderKind::Bitbucket, "bitbucket.org", None);
        assert_eq!(
            bb[0],
            TokenSource::CredentialManager {
                target: "bashboard:bitbucket.org".into()
            }
        );
        assert!(matches!(bb[1], TokenSource::GitCredential { .. }));
    }

    fn resolved(kind: ProviderKind, accounts: &[&str]) -> Resolved {
        Resolved {
            repo: RepoRef {
                provider: kind,
                host: "github.com".into(),
                path: vec!["a".into(), "b".into()],
                web_url: String::new(),
            },
            branch: None,
            account: accounts.first().map(|s| s.to_string()),
            account_source: AccountSource::None,
            accounts: accounts.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn signed_out_bitbucket_says_which_case() {
        let r = resolved(ProviderKind::Bitbucket, &[]);
        let e = decorate(ForgeError::new(ForgeErrorKind::SignedOut, "x"), &r, None);
        assert!(e.message.contains("No Bitbucket API token is stored"));
        assert_eq!(
            e.sign_in,
            Some(vec!["bb".into(), "auth".into(), "bitbucket".into()])
        );
        let stored = Token {
            value: "fake".into(),
            source: TokenSource::CredentialManager {
                target: BITBUCKET_CREDENTIAL.into(),
            },
            expires: None,
        };
        let e = decorate(
            ForgeError::new(ForgeErrorKind::SignedOut, "x"),
            &r,
            Some(&stored),
        );
        assert!(e.message.contains("was rejected"));
        assert_eq!(e.url.as_deref(), Some(BITBUCKET_TOKEN_URL));
    }

    #[test]
    fn not_found_with_several_accounts_points_at_the_picker() {
        let e = decorate(
            ForgeError::new(ForgeErrorKind::NotFound, "x"),
            &resolved(ProviderKind::Github, &["a", "b"]),
            None,
        );
        assert!(e.message.contains("another account"));
        let e = decorate(
            ForgeError::new(ForgeErrorKind::NotFound, "x"),
            &resolved(ProviderKind::Github, &["a"]),
            None,
        );
        assert_eq!(e.message, "x");
    }

    #[test]
    fn remote_selection_and_errors() {
        use crate::git::test_support::{repo, sh, temp_dir};
        let none = HashMap::new();
        let plain = temp_dir("forge-plain");
        let g = repo("forge");
        assert_eq!(
            resolve_repo(&g.at(plain.clone()), &none).unwrap_err().kind,
            ForgeErrorKind::NotARepo
        );
        let _ = std::fs::remove_dir_all(&plain);
        assert_eq!(
            resolve_repo(&g, &none).unwrap_err().kind,
            ForgeErrorKind::NoRemote
        );
        // The only remote, before any commit.
        sh(
            g.root(),
            &["remote", "add", "upstream", "https://github.com/a/b.git"],
        );
        let r = resolve_repo(&g, &none).unwrap();
        assert_eq!(
            (r.repo.provider, r.repo.path.clone()),
            (ProviderKind::Github, vec!["a".into(), "b".into()])
        );
        assert_eq!(r.branch.as_deref(), Some("main"));
        // `origin` wins among several.
        sh(
            g.root(),
            &[
                "remote",
                "add",
                "origin",
                "https://me@bitbucket.org/ws/slug.git",
            ],
        );
        assert_eq!(
            resolve_repo(&g, &none).unwrap().repo.provider,
            ProviderKind::Bitbucket
        );
        // The branch's upstream remote wins over `origin`.
        sh(g.root(), &["config", "branch.main.remote", "upstream"]);
        assert_eq!(
            resolve_repo(&g, &none).unwrap().repo.provider,
            ProviderKind::Github
        );
        sh(
            g.root(),
            &["config", "--local", "credential.username", "carol"],
        );
        let r = resolve_repo(&g, &none).unwrap();
        assert_eq!(
            (r.account.as_deref(), r.account_source),
            (Some("carol"), AccountSource::RepoConfig)
        );
        // A host nobody serves yet.
        sh(
            g.root(),
            &["remote", "set-url", "upstream", "git@gitlab.com:g/p.git"],
        );
        let e = resolve_repo(&g, &none).unwrap_err();
        assert_eq!(
            (e.kind, e.message.as_str(), e.url.as_deref()),
            (
                ForgeErrorKind::UnsupportedHost,
                "GitLab isn't supported yet",
                Some("https://gitlab.com")
            )
        );
    }

    /// Live: resolves this checkout's own remote and a token for it, printing neither the
    /// token nor its length. `cargo test forge::tests::live -- --ignored`.
    #[test]
    #[ignore]
    fn live_resolve_this_repo() {
        let g = crate::git::test_support::repo("forge-live");
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let git = g.at(here);
        let r = resolve_repo(&git, &HashMap::new()).unwrap();
        assert_eq!(r.repo.provider, ProviderKind::Github);
        let token = auth::resolve(
            &git,
            &token_sources(r.repo.provider, &r.repo.host, r.account.as_deref()),
        )
        .unwrap();
        assert!(!token.value.is_empty());
        assert!(matches!(token.source, TokenSource::Cli { .. }));
    }

    #[test]
    fn owner_and_name_split_the_path() {
        let mut r = resolved(ProviderKind::Github, &[]);
        r.repo.path = vec!["group".into(), "sub".into(), "proj".into()];
        let f = forge_repo_of(&r);
        assert_eq!((f.owner.as_str(), f.name.as_str()), ("group/sub", "proj"));
    }
}
