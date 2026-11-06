//! The Ship pane's backend: a repo's CI runs and open pull requests from its code host
//! (docs/design.md section 3.20).
//!
//! Every host sits behind `ForgeProvider` and returns the shapes in `types`, so the front end
//! only sees a few capability flags. The commands resolve the repo from its git remote, pick
//! the provider, find a token (`auth`), and call the trait on a blocking thread; the trait's
//! methods are blocking for that reason, which also keeps it object safe without an async
//! trait crate.

pub mod accounts;
pub mod auth;
pub mod azure_devops;
pub mod bitbucket;
pub mod github;
pub mod gitlab;
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
    AccountSource, Capabilities, ForgeError, ForgeErrorKind, ForgeRepo, Job, JobLog, OverviewRepo,
    ProviderKind, PullChecks, PullChecksQuery, PullList, RepoRef, Run, Token,
};

const REPO_TTL: Duration = Duration::from_secs(15);
const DEFAULT_BRANCH_TTL: Duration = Duration::from_secs(60 * 60);
/// A target key naming a repo by `<host>/<path>` rather than by a local clone's folder.
const REMOTE_PREFIX: &str = "remote:";
const MAX_RUNS: usize = 20;
const MAX_PULLS: usize = 50;
const GH_INSTALL_URL: &str = "https://cli.github.com";
const BITBUCKET_TOKEN_URL: &str = "https://id.atlassian.com/manage-profile/security/api-tokens";
pub const BITBUCKET_CREDENTIAL: &str = crate::credential_store::BITBUCKET_TARGET;
const GLAB_INSTALL_URL: &str = "https://gitlab.com/gitlab-org/cli";
/// The variable the Azure CLI's devops extension reads a PAT from.
pub const AZURE_DEVOPS_PAT_VAR: &str = "AZURE_DEVOPS_EXT_PAT";

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
    /// The most recently updated pull requests: open ones only, or those in any state, and
    /// with `branch` only those whose source branch it is.
    fn pulls(
        &self,
        cx: &Cx,
        repo: &RepoRef,
        open_only: bool,
        branch: Option<&str>,
    ) -> Result<PullList, ForgeError>;
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
    /// The branch the host treats as the repo's default; `None` when it does not say.
    fn default_branch(&self, _cx: &Cx, _repo: &RepoRef) -> Result<Option<String>, ForgeError> {
        Ok(None)
    }
}

static GITHUB: github::GitHub = github::GitHub;
static BITBUCKET: bitbucket::Bitbucket = bitbucket::Bitbucket;
static GITLAB: gitlab::GitLab = gitlab::GitLab;
static AZURE_DEVOPS: azure_devops::AzureDevOps = azure_devops::AzureDevOps;

/// `None` for a host the remote parser knows but no provider serves; every kind has one today.
pub fn provider(kind: ProviderKind) -> Option<&'static dyn ForgeProvider> {
    match kind {
        ProviderKind::Github => Some(&GITHUB),
        ProviderKind::Bitbucket => Some(&BITBUCKET),
        ProviderKind::Gitlab => Some(&GITLAB),
        ProviderKind::AzureDevOps => Some(&AZURE_DEVOPS),
    }
}

/// Where each provider's token comes from, in order. `org` is the Azure DevOps organization,
/// which picks its stored PAT and Git Credential Manager's per-path credential; other providers
/// ignore it.
pub fn token_sources(
    kind: ProviderKind,
    host: &str,
    account: Option<&str>,
    org: Option<&str>,
) -> Vec<TokenSource> {
    let git_credential = TokenSource::GitCredential {
        host: host.to_string(),
        username: account.map(str::to_string),
        path: None,
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
        ProviderKind::Gitlab => vec![
            TokenSource::Glab {
                host: bare_host(host).to_string(),
            },
            TokenSource::GitCredential {
                host: host.to_string(),
                username: None,
                path: None,
            },
        ],
        ProviderKind::AzureDevOps => {
            let org = org.map(str::trim).filter(|o| !o.is_empty());
            // A name that can't be an organization has no stored PAT to read.
            let stored = org
                .and_then(|o| crate::credential_store::azure_devops_target(o).ok())
                .map(|target| TokenSource::CredentialManager { target });
            stored
                .into_iter()
                .chain([
                    TokenSource::Env {
                        var: AZURE_DEVOPS_PAT_VAR.into(),
                    },
                    TokenSource::AzCli,
                    TokenSource::GitCredential {
                        host: host.to_string(),
                        username: None,
                        path: org.map(str::to_string),
                    },
                ])
                .collect()
        }
    }
}

/// The Azure DevOps organization a repo is in, lowercased as its stored PAT's target is.
fn azure_org(r: &Resolved) -> Option<String> {
    (r.repo.provider == ProviderKind::AzureDevOps)
        .then(|| r.repo.path.first().map(|o| o.to_lowercase()))
        .flatten()
}

/// The `account` slot of the token cache key. Azure DevOps has no account picker but a token
/// per organization, so its organization goes there; it stays out of `Resolved::account`,
/// which the pane shows as the account chip.
fn token_account(r: &Resolved) -> Option<String> {
    azure_org(r).or_else(|| r.account.clone())
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

type RepoKey = (ProviderKind, String, Vec<String>);

#[derive(Default)]
pub struct ForgeState {
    http: Http,
    tokens: TokenCache,
    /// By target key: a local folder, or `remote:<host>/<path>`.
    repos: Mutex<HashMap<String, (Instant, Resolved)>>,
    default_branches: Mutex<HashMap<RepoKey, (Instant, Option<String>)>>,
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
    let repo =
        remote::classify(&parsed, hosts, &gh_hosts).ok_or_else(|| unknown_host(&parsed.host))?;
    let (accounts, active) = served_accounts(&repo, &hosts_yml)?;
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

/// The repo never resolves for these, so `url` is how the notice learns the host to name.
fn unsupported(host: &str, message: String) -> ForgeError {
    ForgeError {
        url: Some(format!("https://{host}")),
        ..ForgeError::new(ForgeErrorKind::UnsupportedHost, message)
    }
}

fn unknown_host(host: &str) -> ForgeError {
    unsupported(
        host,
        format!(
            "{host} isn't a code host Bashboard recognizes. Name its provider in the ship.hosts setting."
        ),
    )
}

/// Refuses a provider nobody serves yet, then lists the host's GitHub CLI accounts and the
/// active one.
fn served_accounts(
    repo: &RepoRef,
    hosts_yml: &str,
) -> Result<(Vec<String>, Option<String>), ForgeError> {
    if provider(repo.provider).is_none() {
        return Err(unsupported(
            &repo.host,
            format!("{} isn't supported yet", repo.provider.display_name()),
        ));
    }
    Ok(match repo.provider {
        ProviderKind::Github => auth::gh_accounts(hosts_yml, bare_host(&repo.host)),
        _ => (Vec::new(), None),
    })
}

/// A repo named by a `remote:` target key. With no clone there is no branch and no repo
/// config, so the account is the one a fresh clone would get: the host's only or active
/// GitHub CLI account.
fn resolve_remote(
    spec: &str,
    hosts: &HashMap<String, ProviderKind>,
    hosts_yml: &str,
) -> Result<Resolved, ForgeError> {
    let gh_hosts = remote::parse_gh_hosts(hosts_yml);
    let repo = remote::parse_repo_input(spec, hosts, &gh_hosts).ok_or_else(|| {
        // The spec stays out of the message, as a remote URL does: a pasted one can carry a
        // password.
        ForgeError::new(
            ForgeErrorKind::UnsupportedHost,
            "This repo address isn't one Bashboard can read. Use host/owner/name, or name a self-hosted host's provider in the ship.hosts setting.",
        )
    })?;
    let (accounts, active) = served_accounts(&repo, hosts_yml)?;
    let (account, account_source) = auth::choose_account(None, None, &accounts, active.as_deref());
    Ok(Resolved {
        repo,
        branch: None,
        account,
        account_source,
        accounts,
    })
}

/// Git Bash's rule: `HOME`, falling back to `USERPROFILE`.
fn home_dir() -> Option<String> {
    ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(|v| std::env::var(v).ok())
        .find(|h| !h.is_empty())
}

/// A `Git` with no repo, run in the home folder so `git credential fill` reads only the global
/// and system credential helpers.
fn home_git(settings: &SettingsState) -> Result<Git, ForgeError> {
    let home = home_dir().ok_or_else(|| ForgeError::other("Could not find the home folder."))?;
    Git::open(settings, &home).map_err(ForgeError::other)
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
    fn cached(
        &self,
        key: &str,
        resolve: impl FnOnce() -> Result<Resolved, ForgeError>,
    ) -> Result<Resolved, ForgeError> {
        if let Some((at, r)) = self.repos.lock().unwrap().get(key) {
            if at.elapsed() < REPO_TTL {
                return Ok(r.clone());
            }
        }
        let r = resolve()?;
        self.repos
            .lock()
            .unwrap()
            .insert(key.to_string(), (Instant::now(), r.clone()));
        Ok(r)
    }

    /// The repo a target key names, with the `Git` its token is resolved through. A local
    /// target's `Git` runs in its clone. A `remote:` target has no clone, so its `Git` runs in
    /// the home folder only for `git credential fill`, which then reads the credential helpers
    /// from global and system config. No token source reads a repo's own config (`gh` and
    /// Windows Credential Manager run no git at all), so this finds what a clone would.
    fn target(
        &self,
        settings: &SettingsState,
        target: &str,
    ) -> Result<(Git, Resolved), ForgeError> {
        match target.strip_prefix(REMOTE_PREFIX) {
            Some(spec) => {
                let git = home_git(settings)?;
                let r = self.cached(target, || {
                    let hosts_yml = remote::read_gh_hosts_yml().unwrap_or_default();
                    resolve_remote(spec, &forge_hosts(settings), &hosts_yml)
                })?;
                Ok((git, r))
            }
            None => {
                let git = open_git(settings, target)?;
                let r = self.cached(target, || resolve_repo(&git, &forge_hosts(settings)))?;
                Ok((git, r))
            }
        }
    }

    /// The host's default branch, cached for an hour. A failed lookup caches nothing.
    fn default_branch(&self, git: &Git, r: &Resolved) -> Option<String> {
        let key = (r.repo.provider, r.repo.host.clone(), r.repo.path.clone());
        if let Some((at, b)) = self.default_branches.lock().unwrap().get(&key) {
            if at.elapsed() < DEFAULT_BRANCH_TTL {
                return b.clone();
            }
        }
        let b = with_provider_in(self, git, r, |p, cx, repo| p.default_branch(cx, repo)).ok()?;
        self.default_branches
            .lock()
            .unwrap()
            .insert(key, (Instant::now(), b.clone()));
        b
    }

    fn token(&self, git: &Git, r: &Resolved, fresh: bool) -> Result<Token, ForgeError> {
        let (kind, host) = (r.repo.provider, bare_host(&r.repo.host));
        let key = token_account(r);
        if !fresh {
            if let Some(t) = self.tokens.get(kind, host, key.as_deref()) {
                return Ok(t);
            }
        }
        let org = azure_org(r);
        let sources = token_sources(kind, &r.repo.host, r.account.as_deref(), org.as_deref());
        let token = auth::resolve(git, &sources)?;
        self.tokens.put(kind, host, key.as_deref(), token.clone());
        Ok(token)
    }
}

/// Turns a final `signedOut` into the notice's next step, and points a GitHub `notFound` on a
/// host with several accounts at the account picker.
fn decorate(mut e: ForgeError, r: &Resolved, token: Option<&Token>) -> ForgeError {
    let host = bare_host(&r.repo.host);
    if r.repo.provider == ProviderKind::AzureDevOps {
        e.az_cli = Some(auth::locate_program("az").is_some());
    }
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
                    e.message = "No Bitbucket API token is stored. Add one in the Accounts tab, or run bb auth bitbucket.".into()
                }
                Some(TokenSource::CredentialManager { .. }) => {
                    e.message = "The stored Bitbucket API token was rejected (it may have expired or lack a scope). Replace it in the Accounts tab, or run bb auth bitbucket.".into()
                }
                // A Git Credential Manager token's message comes from the provider.
                Some(_) => {}
            }
            e.url = Some(BITBUCKET_TOKEN_URL.into());
            e.sign_in = Some(["bb", "auth", "bitbucket"].map(String::from).to_vec());
        }
        (ForgeErrorKind::SignedOut, ProviderKind::Gitlab) => match auth::locate_program("glab") {
            Some(_) => {
                e.message = format!(
                    "Sign in to GitLab CLI for {host} to see this repo's pipelines and merge requests."
                );
                e.sign_in = Some(
                    ["glab", "auth", "login", "--hostname", host]
                        .map(String::from)
                        .to_vec(),
                );
            }
            None => {
                e.kind = ForgeErrorKind::NotInstalled;
                e.message = "GitLab CLI isn't installed. Install it, then sign in.".into();
                e.url = Some(GLAB_INSTALL_URL.into());
                e.sign_in = Some(
                    ["winget", "install", "--id", "GLab.GLab", "-e"]
                        .map(String::from)
                        .to_vec(),
                );
            }
        },
        (ForgeErrorKind::SignedOut | ForgeErrorKind::Forbidden, ProviderKind::AzureDevOps) => {
            let org = azure_org(r).unwrap_or_default();
            if e.kind == ForgeErrorKind::SignedOut {
                e.message = azure_signed_out_message(&org, token.map(|t| &t.source));
            }
            e.url = Some(azure_devops::token_page_url(&org));
            e.sign_in = Some(
                ["bb", "auth", "azure-devops", org.as_str()]
                    .map(String::from)
                    .to_vec(),
            );
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

/// A refused or missing Azure DevOps sign-in, by the source that failed. A rejected PAT says
/// "rejected", which the notice keys on to offer Replace token, and is reported rather than
/// passed over for the Azure CLI, so a stale PAT never hides behind another identity.
fn azure_signed_out_message(org: &str, source: Option<&TokenSource>) -> String {
    match source {
        None => format!(
            "No Azure DevOps sign-in was found for {org}. Add a personal access token in the Accounts tab, or run bb auth azure-devops {org}."
        ),
        Some(TokenSource::CredentialManager { .. }) => format!(
            "The stored Azure DevOps token for {org} was rejected: it may have expired, been revoked, or been made for another organization."
        ),
        Some(TokenSource::Env { var }) => format!(
            "The {var} token was rejected by {org}: it may have expired, been revoked, or been made for another organization."
        ),
        // A wrong tenant answers the same as no access at all, and Azure CLI picks the tenant
        // at sign-in.
        Some(TokenSource::AzCli) => format!(
            "Azure DevOps did not accept the Azure CLI sign-in for {org}. If the organization belongs to another tenant, run az login --tenant <tenant>."
        ),
        Some(_) => format!(
            "Azure DevOps did not accept Git Credential Manager's sign-in for {org}. Add a personal access token in the Accounts tab."
        ),
    }
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
    target: &str,
    call: impl Fn(&dyn ForgeProvider, &Cx, &RepoRef) -> Result<T, ForgeError>,
) -> Result<T, ForgeError> {
    let state = app.state::<ForgeState>();
    let (git, r) = state.target(&app.state::<SettingsState>(), target)?;
    with_provider_in(&state, &git, &r, call)
}

fn with_provider_in<T>(
    state: &ForgeState,
    git: &Git,
    r: &Resolved,
    call: impl Fn(&dyn ForgeProvider, &Cx, &RepoRef) -> Result<T, ForgeError>,
) -> Result<T, ForgeError> {
    let p = provider(r.repo.provider).ok_or_else(|| ForgeError::other("no provider"))?;
    let mut fresh = false;
    let mut refreshed: Option<Token> = None;
    loop {
        let token = match refreshed.take() {
            Some(t) => t,
            None => match state.token(git, r, fresh) {
                Ok(t) => t,
                Err(e) => return Err(decorate(e, r, None)),
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
                    .drop_one(r.repo.provider, host, token_account(r).as_deref());
                if fresh {
                    return Err(decorate(e, r, Some(&token)));
                }
                fresh = true;
            }
            Err(e) if e.kind == ForgeErrorKind::Forbidden && !fresh => {
                let host = bare_host(&r.repo.host);
                state
                    .tokens
                    .drop_one(r.repo.provider, host, token_account(r).as_deref());
                // A failed re-resolve leaves the original 403 as the answer.
                match state.token(git, r, true) {
                    Ok(next) if retry_after_refresh(e.kind, &token, &next) => {
                        refreshed = Some(next);
                        fresh = true;
                    }
                    _ => return Err(decorate(e, r, Some(&token))),
                }
            }
            Err(e) => return Err(decorate(e, r, Some(&token))),
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

/// `root` here and in every command below is a target key: a local folder, or
/// `remote:<host>/<path>` for a repo with no clone.
#[tauri::command]
pub async fn forge_repo(app: AppHandle, root: String) -> Result<ForgeRepo, ForgeError> {
    blocking(move || {
        let (_, r) = app
            .state::<ForgeState>()
            .target(&app.state::<SettingsState>(), &root)?;
        Ok(forge_repo_of(&r))
    })
    .await
}

/// Runs, open pull requests, and the default branch at once. An error from runs or pull
/// requests stands; a failed default-branch lookup only leaves it `None`.
fn overview(state: &ForgeState, git: &Git, r: &Resolved) -> Result<OverviewRepo, ForgeError> {
    // One token lookup up front, so the three requests below share it rather than each
    // running the token sources on a cold cache.
    let _ = state.token(git, r, false);
    std::thread::scope(|s| {
        let pulls =
            s.spawn(|| with_provider_in(state, git, r, |p, cx, repo| p.pulls(cx, repo, true, None)));
        let default_branch = s.spawn(|| state.default_branch(git, r));
        let mut runs = with_provider_in(state, git, r, |p, cx, repo| p.runs(cx, repo, None))?;
        runs.truncate(MAX_RUNS);
        let mut pulls = pulls
            .join()
            .map_err(|_| ForgeError::other("Listing pull requests failed."))??;
        pulls.items.truncate(MAX_PULLS);
        Ok(OverviewRepo {
            repo: forge_repo_of(r),
            default_branch: default_branch.join().ok().flatten(),
            runs,
            pulls,
        })
    })
}

/// One Overview row for a target key.
#[tauri::command]
pub async fn forge_overview_repo(
    app: AppHandle,
    target: String,
) -> Result<OverviewRepo, ForgeError> {
    blocking(move || {
        let state = app.state::<ForgeState>();
        let (git, r) = state.target(&app.state::<SettingsState>(), &target)?;
        overview(&state, &git, &r)
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
/// `open_only` is false, which takes every state; `branch` `None` means every source branch.
#[tauri::command]
pub async fn forge_pulls(
    app: AppHandle,
    root: String,
    open_only: Option<bool>,
    branch: Option<String>,
) -> Result<PullList, ForgeError> {
    let open_only = open_only.unwrap_or(true);
    blocking(move || {
        let mut pulls = with_provider(&app, &root, |p, cx, repo| {
            p.pulls(cx, repo, open_only, branch.as_deref())
        })?;
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
        if root.starts_with(REMOTE_PREFIX) {
            return Err(ForgeError::other(
                "This repo has no local clone, so there is no repo config to store an account in.",
            ));
        }
        let settings = app.state::<SettingsState>();
        let state = app.state::<ForgeState>();
        let (git, r) = state.target(&settings, &root)?;
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
        let (_, r) = state.target(&settings, &root)?;
        Ok(forge_repo_of(&r))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_and_capabilities() {
        let gl = provider(ProviderKind::Gitlab).unwrap();
        assert_eq!(gl.kind(), ProviderKind::Gitlab);
        let c = gl.capabilities();
        assert!(c.rerun && c.rerun_failed && c.cancel && c.job_logs && c.drafts && !c.accounts);
        assert_eq!(
            (c.pr_noun.as_str(), c.run_noun.as_str(), c.min_poll_secs),
            ("merge request", "pipeline", 10)
        );
        let ado = provider(ProviderKind::AzureDevOps).unwrap();
        assert_eq!(ado.kind(), ProviderKind::AzureDevOps);
        let c = ado.capabilities();
        assert!(!c.rerun && c.rerun_failed && c.cancel && !c.accounts);
        assert_eq!((c.run_noun.as_str(), c.min_poll_secs), ("build", 20));
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
        let gh = token_sources(ProviderKind::Github, "github.com", Some("bob"), Some("x"));
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
                username: Some("bob".into()),
                path: None,
            }
        );
        let bb = token_sources(ProviderKind::Bitbucket, "bitbucket.org", None, None);
        assert_eq!(
            bb[0],
            TokenSource::CredentialManager {
                target: "bashboard:bitbucket.org".into()
            }
        );
        assert!(matches!(bb[1], TokenSource::GitCredential { .. }));
        assert_eq!(bb.len(), 2);
    }

    #[test]
    fn token_sources_for_gitlab() {
        let gl = token_sources(
            ProviderKind::Gitlab,
            "gitlab.example.com:8443",
            Some("ignored"),
            Some("ignored"),
        );
        assert_eq!(
            gl,
            vec![
                TokenSource::Glab {
                    host: "gitlab.example.com".into()
                },
                TokenSource::GitCredential {
                    host: "gitlab.example.com:8443".into(),
                    username: None,
                    path: None,
                },
            ]
        );
    }

    #[test]
    fn token_sources_for_azure_devops() {
        let ado = token_sources(
            ProviderKind::AzureDevOps,
            "dev.azure.com",
            None,
            Some("Contoso"),
        );
        assert_eq!(
            ado,
            vec![
                TokenSource::CredentialManager {
                    target: "bashboard:dev.azure.com/contoso".into()
                },
                TokenSource::Env {
                    var: "AZURE_DEVOPS_EXT_PAT".into()
                },
                TokenSource::AzCli,
                TokenSource::GitCredential {
                    host: "dev.azure.com".into(),
                    username: None,
                    path: Some("Contoso".into()),
                },
            ]
        );
        // No usable organization: no stored PAT to read, and GCM gets no path.
        for org in [None, Some(""), Some("bad/org")] {
            let ado = token_sources(ProviderKind::AzureDevOps, "dev.azure.com", None, org);
            assert_eq!(
                ado[0],
                TokenSource::Env {
                    var: "AZURE_DEVOPS_EXT_PAT".into()
                }
            );
            assert_eq!(ado[1], TokenSource::AzCli);
            assert!(matches!(ado[2], TokenSource::GitCredential { .. }));
            assert_eq!(ado.len(), 3, "{org:?}");
        }
    }

    fn azure_resolved() -> Resolved {
        Resolved {
            repo: RepoRef {
                provider: ProviderKind::AzureDevOps,
                host: "dev.azure.com".into(),
                path: vec!["Contoso".into(), "Proj".into(), "repo".into()],
                web_url: String::new(),
            },
            branch: None,
            account: None,
            account_source: AccountSource::None,
            accounts: Vec::new(),
        }
    }

    #[test]
    fn azure_devops_caches_by_organization() {
        let r = azure_resolved();
        assert_eq!(token_account(&r).as_deref(), Some("contoso"));
        // Not the account chip.
        assert_eq!(forge_repo_of(&r).account, None);
        let gh = resolved(ProviderKind::Github, &["alice"]);
        assert_eq!(token_account(&gh).as_deref(), Some("alice"));
    }

    fn azure_token(source: TokenSource) -> Token {
        Token {
            value: "fake".into(),
            source,
            expires: None,
        }
    }

    #[test]
    fn signed_out_azure_devops_says_which_source() {
        let r = azure_resolved();
        let signed_out = || ForgeError::new(ForgeErrorKind::SignedOut, "x");
        let e = decorate(signed_out(), &r, None);
        assert!(
            e.message.contains("No Azure DevOps sign-in"),
            "{}",
            e.message
        );
        assert_eq!(
            e.sign_in,
            Some(
                ["bb", "auth", "azure-devops", "contoso"]
                    .map(String::from)
                    .to_vec()
            )
        );
        assert_eq!(
            e.url.as_deref(),
            Some("https://dev.azure.com/contoso/_usersSettings/tokens")
        );
        let stored = azure_token(TokenSource::CredentialManager {
            target: "bashboard:dev.azure.com/contoso".into(),
        });
        let e = decorate(signed_out(), &r, Some(&stored));
        assert_eq!(e.kind, ForgeErrorKind::SignedOut);
        assert_eq!(
            e.message,
            "The stored Azure DevOps token for contoso was rejected: it may have expired, been revoked, or been made for another organization."
        );
        let env = azure_token(TokenSource::Env {
            var: "AZURE_DEVOPS_EXT_PAT".into(),
        });
        let e = decorate(signed_out(), &r, Some(&env));
        assert!(e.message.contains("rejected"), "{}", e.message);
        assert!(e.message.contains("AZURE_DEVOPS_EXT_PAT"));
        let e = decorate(signed_out(), &r, Some(&azure_token(TokenSource::AzCli)));
        assert_eq!(e.kind, ForgeErrorKind::SignedOut);
        assert!(e.message.contains("az login --tenant"), "{}", e.message);
        assert!(!e.message.contains("rejected"));
        // A missing scope keeps the provider's message and gains the way to a new token.
        let forbidden = azure_devops::missing_scope(azure_devops::SCOPE_BUILD_EXECUTE);
        let e = decorate(forbidden.clone(), &r, Some(&stored));
        assert_eq!(
            (e.kind, &e.message),
            (ForgeErrorKind::Forbidden, &forbidden.message)
        );
        assert!(e.message.contains("Build (Read & execute)"));
        assert!(e.sign_in.is_some());
    }

    #[test]
    fn signed_out_gitlab_signs_in_or_installs() {
        let mut r = resolved(ProviderKind::Gitlab, &[]);
        r.repo.host = "gitlab.example.com".into();
        let e = decorate(ForgeError::new(ForgeErrorKind::SignedOut, "x"), &r, None);
        match auth::locate_program("glab") {
            Some(_) => {
                assert_eq!(e.kind, ForgeErrorKind::SignedOut);
                assert_eq!(
                    e.sign_in,
                    Some(
                        ["glab", "auth", "login", "--hostname", "gitlab.example.com"]
                            .map(String::from)
                            .to_vec()
                    )
                );
            }
            None => {
                assert_eq!(e.kind, ForgeErrorKind::NotInstalled);
                assert_eq!(e.url.as_deref(), Some(GLAB_INSTALL_URL));
                assert!(e.sign_in.unwrap().contains(&"GLab.GLab".to_string()));
            }
        }
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
        assert!(e.message.contains("Accounts tab"));
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
        assert!(e.message.contains("Accounts tab"));
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
        // GitLab resolves; its stub provider answers calls until it is served.
        sh(
            g.root(),
            &["remote", "set-url", "upstream", "git@gitlab.com:g/p.git"],
        );
        let r = resolve_repo(&g, &none).unwrap();
        assert_eq!(
            (r.repo.provider, r.repo.path.clone()),
            (ProviderKind::Gitlab, vec!["g".into(), "p".into()])
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
            &token_sources(
                r.repo.provider,
                &r.repo.host,
                r.account.as_deref(),
                azure_org(&r).as_deref(),
            ),
        )
        .unwrap();
        assert!(!token.value.is_empty());
        assert!(matches!(token.source, TokenSource::Cli { .. }));
    }

    #[test]
    fn remote_targets_resolve_without_a_clone() {
        let yml = auth::tests::SAMPLE_HOSTS_YML;
        let none = HashMap::new();
        let r = resolve_remote("github.com/a/b", &none, yml).unwrap();
        assert_eq!(
            (
                r.repo.provider,
                r.branch.as_deref(),
                r.account.as_deref(),
                r.account_source
            ),
            (
                ProviderKind::Github,
                None,
                Some("alice"),
                AccountSource::CliActive
            )
        );
        assert_eq!(r.accounts, vec!["alice", "bob"]);
        let r = resolve_remote("bitbucket.org/keysys/kweb", &none, yml).unwrap();
        assert_eq!(
            (r.repo.provider, r.account.as_deref(), r.account_source),
            (ProviderKind::Bitbucket, None, AccountSource::None)
        );
        assert!(r.accounts.is_empty());
        let f = forge_repo_of(&r);
        assert_eq!(
            (f.owner.as_str(), f.name.as_str(), f.branch.as_deref()),
            ("keysys", "kweb", None)
        );
        // GitHub Enterprise from hosts.yml, port kept.
        let r = resolve_remote("ghe.example.com:8443/team/app", &none, yml).unwrap();
        assert_eq!(
            (r.repo.host.as_str(), r.account.as_deref(), r.account_source),
            ("ghe.example.com:8443", Some("carol"), AccountSource::Only)
        );
        let r = resolve_remote("gitlab.com/g/s/p", &none, yml).unwrap();
        assert_eq!(
            (r.repo.provider, r.repo.path.len(), r.account.as_deref()),
            (ProviderKind::Gitlab, 3, None)
        );
        assert_eq!(forge_repo_of(&r).capabilities.pr_noun, "merge request");
        let e = resolve_remote("https://user:secret@unknown.example/a/b", &none, yml).unwrap_err();
        assert_eq!(e.kind, ForgeErrorKind::UnsupportedHost);
        assert!(!e.message.contains("secret"));
    }

    #[test]
    fn owner_and_name_split_the_path() {
        let mut r = resolved(ProviderKind::Github, &[]);
        r.repo.path = vec!["group".into(), "sub".into(), "proj".into()];
        let f = forge_repo_of(&r);
        assert_eq!((f.owner.as_str(), f.name.as_str()), ("group/sub", "proj"));
    }
}
