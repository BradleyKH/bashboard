//! The Accounts tab's commands: which credential the Ship pane would use for each host and
//! whether the host is used on this machine, a sign-in check, the tokens Bashboard stores
//! (Bitbucket's, and one per Azure DevOps organization), GitHub CLI's account switch and
//! sign-out, and GitLab CLI's sign-out. Token values stay in the core; only the token field sends
//! one in (see `auth`).

use std::collections::{BTreeMap, HashMap};
use std::process::{Command, Stdio};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::auth::{self, TokenSource};
use super::types::{
    AuthChanged, AuthCheck, ForgeError, ForgeErrorKind, HostAuth, Known, ProviderKind, RepoRef,
    StoredToken, TokenSourceKind,
};
use super::{
    AZURE_DEVOPS_PAT_VAR, ForgeState, azure_devops, azure_signed_out_message, bare_host, blocking,
    forge_hosts, git_value, github, home_git, open_git, remote, token_sources,
};
use crate::credential_store;
use crate::git::Git;
use crate::settings::SettingsState;

const GITHUB_HOST: &str = "github.com";
const GITLAB_HOST: &str = "gitlab.com";
const BITBUCKET_HOST: &str = "bitbucket.org";
const AZURE_DEVOPS_HOST: &str = "dev.azure.com";
const BITBUCKET_USER_URL: &str = "https://api.bitbucket.org/2.0/user";

/// Why a known host is known, as the card's tooltip says it.
const FROM_PIN_OR_PANE: &str = "a pinned repo or open Ship pane";
const FROM_TERMINAL: &str = "a terminal pane's repo";

/// What says a host is used on this machine. Kept apart from the reads that gather it, so the
/// listing is a pure function.
#[derive(Debug, Default)]
pub(crate) struct Signals {
    /// The hosts GitHub CLI is signed in to, from `hosts.yml`.
    pub gh_hosts: Vec<String>,
    /// The hosts in GitLab CLI's config.
    pub glab_hosts: Vec<String>,
    /// The `ship.hosts` setting, keys lowercased.
    pub forge_hosts: HashMap<String, ProviderKind>,
    /// Hosts with a known repo, each with why it is known.
    pub known: Vec<(ProviderKind, String, &'static str)>,
    pub bitbucket_stored: bool,
    pub azure_stored: bool,
    /// Whether `AZURE_DEVOPS_EXT_PAT` holds a value; the value itself is never read here.
    pub azure_env: bool,
    pub az_installed: bool,
}

/// One card the tab lists, with the reasons it counts as detected (none when it doesn't).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Listed {
    pub kind: ProviderKind,
    pub host: String,
    pub detected_by: Vec<String>,
}

/// The provider the four public hosts belong to whatever else says.
fn public_kind(host: &str) -> Option<ProviderKind> {
    match host {
        GITHUB_HOST => Some(ProviderKind::Github),
        GITLAB_HOST => Some(ProviderKind::Gitlab),
        BITBUCKET_HOST => Some(ProviderKind::Bitbucket),
        AZURE_DEVOPS_HOST => Some(ProviderKind::AzureDevOps),
        _ => None,
    }
}

/// Every host with a signal, plus the four public hosts undetected when nothing names them; a
/// self-managed host appears only once detected. Ordered GitHub hosts (`github.com` first, then
/// alphabetically), GitLab hosts alphabetically, `bitbucket.org`, then `dev.azure.com`; the
/// front end splits detected from not without reordering. Bitbucket Cloud and Azure DevOps
/// Services are one card each, so any of their hosts counts toward it. A CLI's host that
/// `ship.hosts` maps to another provider is left out, since the pane would not treat it as that
/// CLI's.
pub(crate) fn listed_hosts(s: &Signals) -> Vec<Listed> {
    type Key = (u8, bool, String);
    let mut cards: BTreeMap<Key, (ProviderKind, Vec<String>)> = BTreeMap::new();
    let mut add = |kind: ProviderKind, host: &str, reason: Option<&str>| {
        let host = match kind {
            ProviderKind::Bitbucket => BITBUCKET_HOST.to_string(),
            ProviderKind::AzureDevOps => AZURE_DEVOPS_HOST.to_string(),
            _ => bare_host(host.trim()).to_ascii_lowercase(),
        };
        if host.is_empty() {
            return;
        }
        let rank = match kind {
            ProviderKind::Github => 0,
            ProviderKind::Gitlab => 1,
            ProviderKind::Bitbucket => 2,
            ProviderKind::AzureDevOps => 3,
        };
        let pinned_first = kind == ProviderKind::Github && host != GITHUB_HOST;
        let (_, reasons) = cards
            .entry((rank, pinned_first, host))
            .or_insert_with(|| (kind, Vec::new()));
        if let Some(r) = reason {
            if !reasons.iter().any(|x| x == r) {
                reasons.push(r.to_string());
            }
        }
    };
    for host in [GITHUB_HOST, GITLAB_HOST, BITBUCKET_HOST, AZURE_DEVOPS_HOST] {
        add(public_kind(host).unwrap(), host, None);
    }
    let kind_of = |host: &str, cli: ProviderKind| {
        let host = host.to_ascii_lowercase();
        s.forge_hosts
            .get(&host)
            .copied()
            .or_else(|| public_kind(&host))
            .unwrap_or(cli)
    };
    for h in &s.gh_hosts {
        if kind_of(h, ProviderKind::Github) == ProviderKind::Github {
            add(ProviderKind::Github, h, Some("GitHub CLI is signed in"));
        }
    }
    for h in &s.glab_hosts {
        if kind_of(h, ProviderKind::Gitlab) == ProviderKind::Gitlab {
            add(
                ProviderKind::Gitlab,
                h,
                Some("GitLab CLI's config names it"),
            );
        }
    }
    for (h, k) in &s.forge_hosts {
        if matches!(k, ProviderKind::Github | ProviderKind::Gitlab) {
            add(*k, h, Some("the ship.hosts setting"));
        }
    }
    for (k, h, why) in &s.known {
        add(*k, h, Some(why));
    }
    if s.bitbucket_stored {
        add(
            ProviderKind::Bitbucket,
            BITBUCKET_HOST,
            Some("a stored API token"),
        );
    }
    if s.azure_stored {
        add(
            ProviderKind::AzureDevOps,
            AZURE_DEVOPS_HOST,
            Some("a stored personal access token"),
        );
    }
    if s.azure_env {
        add(
            ProviderKind::AzureDevOps,
            AZURE_DEVOPS_HOST,
            Some("AZURE_DEVOPS_EXT_PAT is set"),
        );
    }
    if s.az_installed {
        add(
            ProviderKind::AzureDevOps,
            AZURE_DEVOPS_HOST,
            Some("Azure CLI is installed"),
        );
    }
    cards
        .into_iter()
        .map(|((_, _, host), (kind, detected_by))| Listed {
            kind,
            host,
            detected_by,
        })
        .collect()
}

/// The repo a folder is in, from its `origin` remote, else its first. `None` for a folder that
/// isn't a repo or whose remote isn't a code host Bashboard knows.
fn folder_repo(
    settings: &SettingsState,
    dir: &str,
    hosts: &HashMap<String, ProviderKind>,
    gh_hosts: &[String],
) -> Option<RepoRef> {
    let git: Git = open_git(settings, dir).ok()?;
    let remotes = git_value(&git, &["remote"])?;
    let mut names = remotes.lines().map(str::trim).filter(|r| !r.is_empty());
    let first = names.clone().next()?;
    let name = names.find(|r| *r == "origin").unwrap_or(first);
    let url = git_value(&git, &["remote", "get-url", name])?;
    remote::classify(&remote::parse_remote(&url)?, hosts, gh_hosts)
}

/// The Azure DevOps organizations the card can resolve a token for: the stored ones, then those
/// of the known repos, lowercased and deduplicated in order.
pub(crate) fn azure_orgs(stored: &[String], repos: &[RepoRef]) -> Vec<String> {
    let mut orgs: Vec<String> = Vec::new();
    let known = repos
        .iter()
        .filter(|r| r.provider == ProviderKind::AzureDevOps)
        .filter_map(|r| r.path.first());
    for o in stored.iter().chain(known) {
        let o = o.trim().to_lowercase();
        if !o.is_empty() && !orgs.contains(&o) {
            orgs.push(o);
        }
    }
    orgs
}

/// The organizations with a stored Azure DevOps PAT, from the credentials' target names.
fn stored_azure_orgs() -> Vec<String> {
    let mut orgs: Vec<String> =
        credential_store::list_targets(credential_store::AZURE_DEVOPS_PREFIX)
            .iter()
            .filter_map(|t| {
                credential_store::name_from_target(t, credential_store::AZURE_DEVOPS_PREFIX)
            })
            .map(|o| o.to_lowercase())
            .collect();
    orgs.sort();
    orgs.dedup();
    orgs
}

fn env_set(var: &str) -> bool {
    std::env::var_os(var).is_some_and(|v| !v.to_string_lossy().trim().is_empty())
}

pub(crate) fn source_kind(source: &TokenSource) -> TokenSourceKind {
    match source {
        TokenSource::Cli { program, .. } if program == "glab" => TokenSourceKind::GlabCli,
        TokenSource::Cli { .. } => TokenSourceKind::GhCli,
        TokenSource::GitCredential { .. } => TokenSourceKind::GitCredentialManager,
        TokenSource::CredentialManager { .. } => TokenSourceKind::BashboardCredential,
        TokenSource::Glab { .. } => TokenSourceKind::GlabCli,
        TokenSource::AzCli => TokenSourceKind::AzCli,
        TokenSource::Env { .. } => TokenSourceKind::Environment,
    }
}

/// Refuses a user GitHub CLI has not signed in to `host`, so `gh` never gets to prompt.
pub(crate) fn check_signed_in(hosts_yml: &str, host: &str, user: &str) -> Result<(), ForgeError> {
    let (accounts, _) = auth::gh_accounts(hosts_yml, bare_host(host));
    if accounts.iter().any(|a| a == user) {
        Ok(())
    } else {
        Err(ForgeError::other(format!(
            "{user} isn't signed in to GitHub CLI for {}.",
            bare_host(host)
        )))
    }
}

/// The variable GitHub CLI takes the token from for `host` instead of its saved accounts. gh
/// reads `GH_TOKEN` then `GITHUB_TOKEN` for github.com and `*.ghe.com`, and the `_ENTERPRISE_`
/// pair for any other host; an empty value counts as unset.
pub(crate) fn gh_env_token_var(
    host: &str,
    get: impl Fn(&str) -> Option<String>,
) -> Option<&'static str> {
    let host = bare_host(host).to_ascii_lowercase();
    let names: [&'static str; 2] = if host == "github.com" || host.ends_with(".ghe.com") {
        ["GH_TOKEN", "GITHUB_TOKEN"]
    } else {
        ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
    };
    names
        .into_iter()
        .find(|n| get(n).is_some_and(|v| !v.is_empty()))
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Every variable gh would take a token from. `switch` and `logout` refuse while one is set,
/// so `run_gh` drops them to act on the saved accounts, which is what Bashboard's own token
/// lookup reads.
const GH_TOKEN_VARS: [&str; 4] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

/// Drops what the core cached for the host's credentials, then tells the page.
fn auth_changed(app: &AppHandle, kind: ProviderKind, host: &str) {
    let state = app.state::<ForgeState>();
    let bare = bare_host(host);
    state.tokens.drop_host(kind, bare);
    state.repos.lock().unwrap().retain(|_, (_, r)| {
        !(r.repo.provider == kind && bare_host(&r.repo.host).eq_ignore_ascii_case(bare))
    });
    let _ = app.emit(
        "forge://auth-changed",
        AuthChanged {
            provider: kind,
            host: host.to_string(),
        },
    );
}

/// What each CLI and store holds, gathered once for every card.
struct Machine {
    hosts_yml: String,
    gh_installed: bool,
    glab_installed: bool,
    az_installed: bool,
    bitbucket_stored: bool,
    azure_orgs: Vec<String>,
    /// The stored organizations, then those of known repos.
    azure_known_orgs: Vec<String>,
}

fn host_status(git: &Git, m: &Machine, l: &Listed) -> HostAuth {
    let host = l.host.as_str();
    let mut accounts = Vec::new();
    let mut active = None;
    let mut stored_tokens = Vec::new();
    let cli_installed = match l.kind {
        ProviderKind::Github => {
            (accounts, active) = auth::gh_accounts(&m.hosts_yml, bare_host(host));
            m.gh_installed
        }
        ProviderKind::Gitlab => {
            if m.glab_installed {
                active = auth::glab_status(bare_host(host))
                    .and_then(|t| auth::glab_status_user(&t, bare_host(host)));
                accounts.extend(active.clone());
            }
            m.glab_installed
        }
        ProviderKind::Bitbucket => {
            if m.bitbucket_stored {
                stored_tokens.push(StoredToken { org: None });
            }
            false
        }
        ProviderKind::AzureDevOps => {
            if m.az_installed {
                active = auth::az_user();
                accounts.extend(active.clone());
            }
            stored_tokens.extend(m.azure_orgs.iter().map(|o| StoredToken {
                org: Some(o.clone()),
            }));
            m.az_installed
        }
    };
    // Only the source's kind leaves here; the token is dropped. A stored Azure DevOps PAT wins
    // for its organization.
    let token_source = if l.kind == ProviderKind::AzureDevOps && !stored_tokens.is_empty() {
        Some(TokenSourceKind::BashboardCredential)
    } else if l.kind == ProviderKind::AzureDevOps {
        // Git Credential Manager keys Azure DevOps sign-ins by organization path, so a lookup
        // with no organization misses them; each known organization is asked in turn.
        auth::resolve(git, &token_sources(l.kind, host, None, None))
            .ok()
            .or_else(|| {
                m.azure_known_orgs.iter().find_map(|org| {
                    let source = TokenSource::GitCredential {
                        host: host.to_string(),
                        username: None,
                        path: Some(org.clone()),
                    };
                    auth::resolve(git, &[source]).ok()
                })
            })
            .map(|t| source_kind(&t.source))
    } else {
        let account = (l.kind == ProviderKind::Github)
            .then_some(active.as_deref())
            .flatten();
        auth::resolve(git, &token_sources(l.kind, host, account, None))
            .ok()
            .map(|t| source_kind(&t.source))
    };
    HostAuth {
        provider: l.kind,
        host: l.host.clone(),
        cli_installed,
        accounts,
        active_account: active,
        token_source,
        stored_tokens,
        gh_env_token: match l.kind {
            ProviderKind::Github => gh_env_token_var(host, process_env).map(str::to_string),
            _ => None,
        },
        detected: !l.detected_by.is_empty(),
        detected_by: l.detected_by.clone(),
        known_orgs: match l.kind {
            ProviderKind::AzureDevOps => m.azure_known_orgs.clone(),
            _ => Vec::new(),
        },
    }
}

/// Every card the tab shows: the hosts with a signal and the public ones without, each with the
/// credential the Ship pane would use. `known` is the hosts of pins and open Ship panes and the
/// folders of open terminal panes; a folder that isn't a repo is skipped.
#[tauri::command]
pub async fn forge_auth_status(app: AppHandle, known: Known) -> Result<Vec<HostAuth>, ForgeError> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let git = home_git(&settings)?;
        let hosts_yml = remote::read_gh_hosts_yml().unwrap_or_default();
        let gh_hosts = remote::parse_gh_hosts(&hosts_yml);
        let forge_hosts = forge_hosts(&settings);
        let mut known_hosts: Vec<(ProviderKind, String, &'static str)> = known
            .hosts
            .into_iter()
            .map(|h| (h.provider, h.host, FROM_PIN_OR_PANE))
            .collect();
        let mut dirs = known.dirs;
        dirs.sort();
        dirs.dedup();
        let dir_repos: Vec<RepoRef> = dirs
            .iter()
            .filter_map(|d| folder_repo(&settings, d, &forge_hosts, &gh_hosts))
            .collect();
        known_hosts.extend(
            dir_repos
                .iter()
                .map(|r| (r.provider, r.host.clone(), FROM_TERMINAL)),
        );
        // The Ship pane's repos too, since a pane may be open on a repo no terminal is in.
        let pane_repos: Vec<RepoRef> = app
            .state::<ForgeState>()
            .repos
            .lock()
            .unwrap()
            .values()
            .map(|(_, r)| r.repo.clone())
            .collect();
        let azure_stored_orgs = stored_azure_orgs();
        let azure_known_orgs = azure_orgs(&azure_stored_orgs, &[dir_repos, pane_repos].concat());
        let m = Machine {
            gh_installed: auth::locate_program("gh").is_some(),
            glab_installed: auth::locate_program("glab").is_some(),
            az_installed: auth::locate_program("az").is_some(),
            bitbucket_stored: credential_store::exists(credential_store::BITBUCKET_TARGET),
            azure_orgs: azure_stored_orgs,
            azure_known_orgs,
            hosts_yml,
        };
        let listed = listed_hosts(&Signals {
            gh_hosts,
            glab_hosts: remote::read_glab_hosts(),
            forge_hosts,
            known: known_hosts,
            bitbucket_stored: m.bitbucket_stored,
            azure_stored: !m.azure_orgs.is_empty(),
            azure_env: env_set(AZURE_DEVOPS_PAT_VAR),
            az_installed: m.az_installed,
        });
        // Each host runs a CLI and git credential fill, so they go side by side.
        Ok(std::thread::scope(|s| {
            let handles: Vec<_> = listed
                .iter()
                .map(|l| {
                    let (git, m) = (&git, &m);
                    s.spawn(move || host_status(git, m, l))
                })
                .collect();
            handles
                .into_iter()
                .zip(&listed)
                .map(|(t, l)| {
                    t.join().unwrap_or_else(|_| HostAuth {
                        provider: l.kind,
                        host: l.host.clone(),
                        cli_installed: false,
                        accounts: Vec::new(),
                        active_account: None,
                        token_source: None,
                        stored_tokens: Vec::new(),
                        gh_env_token: None,
                        detected: !l.detected_by.is_empty(),
                        detected_by: l.detected_by.clone(),
                        known_orgs: Vec::new(),
                    })
                })
                .collect()
        }))
    })
    .await
}

fn failed(e: ForgeError) -> AuthCheck {
    AuthCheck {
        ok: false,
        login: None,
        scopes: None,
        message: Some(e.message),
    }
}

/// `X-OAuth-Scopes`, which only classic GitHub tokens and OAuth apps send.
fn scopes_of(headers: &[(String, String)]) -> Option<Vec<String>> {
    headers
        .iter()
        .find(|(k, _)| k == "x-oauth-scopes")
        .map(|(_, v)| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
}

fn user_login(kind: ProviderKind, v: &Value) -> Option<String> {
    let field = |name: &str| {
        v.get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    match kind {
        ProviderKind::Bitbucket => field("display_name").or_else(|| field("nickname")),
        ProviderKind::Gitlab => field("username"),
        ProviderKind::AzureDevOps => v
            .pointer("/authenticatedUser/providerDisplayName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        ProviderKind::Github => field("login"),
    }
}

/// Asks the host who the token for `account` on `host` belongs to; for Azure DevOps, the token
/// for organization `org`. Errors come back as `ok: false` with the message, so the tab shows
/// them beside the host.
#[tauri::command]
pub async fn forge_auth_test(
    app: AppHandle,
    provider: ProviderKind,
    host: String,
    account: Option<String>,
    org: Option<String>,
) -> Result<AuthCheck, ForgeError> {
    blocking(move || {
        let host = host.trim().to_ascii_lowercase();
        let org = org
            .map(|o| o.trim().to_lowercase())
            .filter(|o| !o.is_empty());
        if provider == ProviderKind::AzureDevOps && org.is_none() {
            return Ok(failed(ForgeError::other(
                "Open an Azure DevOps repo first, so Bashboard knows an organization to test.",
            )));
        }
        let git = home_git(&app.state::<SettingsState>())?;
        let sources = token_sources(provider, &host, account.as_deref(), org.as_deref());
        let token = match auth::resolve(&git, &sources) {
            Ok(t) => t,
            Err(e) => return Ok(failed(e)),
        };
        let (url, accept, header) = match provider {
            ProviderKind::Github => {
                let repo = RepoRef {
                    provider,
                    host: host.clone(),
                    path: Vec::new(),
                    web_url: String::new(),
                };
                (
                    format!("{}/user", github::api_base(&repo)),
                    "application/vnd.github+json",
                    format!("Bearer {}", token.value),
                )
            }
            ProviderKind::Bitbucket => (
                BITBUCKET_USER_URL.to_string(),
                "application/json",
                format!("Bearer {}", token.value),
            ),
            ProviderKind::Gitlab => (
                format!("https://{host}/api/v4/user"),
                "application/json",
                format!("Bearer {}", token.value),
            ),
            ProviderKind::AzureDevOps => (
                azure_devops::connection_url(&remote::percent_encode(
                    org.as_deref().unwrap_or_default(),
                )),
                "application/json",
                azure_devops::auth_header(&token),
            ),
        };
        let mut headers = vec![("Accept", accept)];
        if provider == ProviderKind::AzureDevOps {
            // Without it a rejected token gets a 302 to a sign-in page, not a 401.
            headers.push(("X-TFS-FedAuthRedirect", "Suppress"));
        }
        let reply = app
            .state::<ForgeState>()
            .http
            .get_json_with_headers::<Value>(&url, Some(&header), &headers);
        let reply = match provider {
            ProviderKind::Bitbucket => {
                reply.map_err(|e| super::bitbucket::reword(e, &token.source))
            }
            ProviderKind::AzureDevOps => reply.map_err(|mut e| {
                if e.kind == ForgeErrorKind::SignedOut {
                    e.message = azure_signed_out_message(
                        org.as_deref().unwrap_or_default(),
                        Some(&token.source),
                    );
                }
                e
            }),
            _ => reply,
        };
        Ok(match reply {
            Ok((body, headers)) => match user_login(provider, &body) {
                Some(login) => AuthCheck {
                    ok: true,
                    login: Some(login),
                    scopes: scopes_of(&headers),
                    message: None,
                },
                // The test exists to say whose token it is, so a reply naming nobody fails it.
                None if provider == ProviderKind::AzureDevOps => failed(ForgeError::other(
                    "Azure DevOps did not say who the token belongs to.",
                )),
                None => AuthCheck {
                    ok: true,
                    login: None,
                    scopes: scopes_of(&headers),
                    message: None,
                },
            },
            Err(e) => failed(e),
        })
    })
    .await
}

/// Where a provider's token is stored, and the host whose cards it changes. Bitbucket ignores
/// `org`; Azure DevOps needs it.
fn stored_target(
    provider: ProviderKind,
    org: Option<&str>,
) -> Result<(String, &'static str, &'static str), String> {
    match provider {
        ProviderKind::Bitbucket => Ok((
            credential_store::BITBUCKET_TARGET.to_string(),
            credential_store::BITBUCKET_USER,
            BITBUCKET_HOST,
        )),
        ProviderKind::AzureDevOps => {
            let org = org.ok_or_else(|| "name the Azure DevOps organization".to_string())?;
            Ok((
                credential_store::azure_devops_target(org)?,
                credential_store::AZURE_DEVOPS_USER,
                AZURE_DEVOPS_HOST,
            ))
        }
        other => Err(format!(
            "Bashboard doesn't store tokens for {}",
            other.display_name()
        )),
    }
}

/// Stores a token in Windows Credential Manager: Bitbucket's, or one Azure DevOps
/// organization's. The token never appears in an error, and every copy here is overwritten
/// before it is freed.
#[tauri::command]
pub async fn forge_set_token(
    app: AppHandle,
    provider: ProviderKind,
    org: Option<String>,
    token: String,
) -> Result<(), ForgeError> {
    blocking(move || {
        let cleaned = credential_store::clean_token(&token);
        credential_store::wipe(token);
        let fail = |e: String| ForgeError::other(format!("Could not store it: {e}."));
        let (target, user, host) = match stored_target(provider, org.as_deref()) {
            Ok(t) => t,
            Err(e) => {
                if let Ok(c) = cleaned {
                    credential_store::wipe(c);
                }
                return Err(fail(e));
            }
        };
        let cleaned = cleaned.map_err(fail)?;
        let written = credential_store::write(&target, user, cleaned.as_bytes());
        credential_store::wipe(cleaned);
        written.map_err(fail)?;
        auth_changed(&app, provider, host);
        Ok(())
    })
    .await
}

/// False when no token was stored.
#[tauri::command]
pub async fn forge_clear_token(
    app: AppHandle,
    provider: ProviderKind,
    org: Option<String>,
) -> Result<bool, ForgeError> {
    blocking(move || {
        let fail = |e: String| ForgeError::other(format!("Could not remove it: {e}."));
        let (target, _, host) = stored_target(provider, org.as_deref()).map_err(fail)?;
        let removed = credential_store::delete(&target).map_err(fail)?;
        if removed {
            auth_changed(&app, provider, host);
        }
        Ok(removed)
    })
    .await
}

/// Runs `gh auth <verb> --hostname <host> --user <user>`. With both flags given neither verb
/// prompts, and `GH_PROMPT_DISABLED` holds it to that.
fn run_gh(verb: &str, host: &str, user: &str) -> Result<(), ForgeError> {
    let hosts_yml = remote::read_gh_hosts_yml().unwrap_or_default();
    check_signed_in(&hosts_yml, host, user)?;
    let gh = auth::locate_program("gh").ok_or_else(|| {
        ForgeError::new(ForgeErrorKind::NotInstalled, "GitHub CLI isn't installed.")
    })?;
    let mut cmd = Command::new(gh);
    cmd.args(["auth", verb, "--hostname", bare_host(host), "--user", user])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for var in GH_TOKEN_VARS {
        cmd.env_remove(var);
    }
    crate::editors::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| ForgeError::other(format!("Could not run GitHub CLI: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(ForgeError::other(if stderr.is_empty() {
        format!("gh auth {verb} failed.")
    } else {
        format!("gh auth {verb} failed: {stderr}")
    }))
}

#[tauri::command]
pub async fn forge_gh_switch(app: AppHandle, host: String, user: String) -> Result<(), ForgeError> {
    blocking(move || {
        let host = host.trim().to_ascii_lowercase();
        run_gh("switch", &host, &user)?;
        auth_changed(&app, ProviderKind::Github, &host);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn forge_gh_logout(app: AppHandle, host: String, user: String) -> Result<(), ForgeError> {
    blocking(move || {
        let host = host.trim().to_ascii_lowercase();
        run_gh("logout", &host, &user)?;
        auth_changed(&app, ProviderKind::Github, &host);
        Ok(())
    })
    .await
}

/// Signs GitLab CLI out of `host`. glab holds one account per host, so there is no user to name.
#[tauri::command]
pub async fn forge_glab_logout(app: AppHandle, host: String) -> Result<(), ForgeError> {
    blocking(move || {
        let host = host.trim().to_ascii_lowercase();
        if auth::locate_program("glab").is_none() {
            return Err(ForgeError::new(
                ForgeErrorKind::NotInstalled,
                "GitLab CLI isn't installed.",
            ));
        }
        auth::glab_logout(bare_host(&host)).map_err(ForgeError::other)?;
        auth_changed(&app, ProviderKind::Gitlab, &host);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::auth::tests::SAMPLE_HOSTS_YML;

    fn listed(s: &Signals) -> Vec<(ProviderKind, String, bool)> {
        listed_hosts(s)
            .into_iter()
            .map(|l| (l.kind, l.host, !l.detected_by.is_empty()))
            .collect()
    }

    fn row(k: ProviderKind, h: &str, detected: bool) -> (ProviderKind, String, bool) {
        (k, h.to_string(), detected)
    }

    fn reasons(s: &Signals, host: &str) -> Vec<String> {
        listed_hosts(s)
            .into_iter()
            .find(|l| l.host == host)
            .map(|l| l.detected_by)
            .unwrap_or_default()
    }

    fn repo(provider: ProviderKind, host: &str, path: &[&str]) -> RepoRef {
        RepoRef {
            provider,
            host: host.into(),
            path: path.iter().map(|s| s.to_string()).collect(),
            web_url: String::new(),
        }
    }

    #[test]
    fn azure_orgs_lead_with_the_stored_then_the_known_repos() {
        let ado = ProviderKind::AzureDevOps;
        let repos = [
            repo(ado, "dev.azure.com", &["Contoso", "Proj", "Repo"]),
            repo(ProviderKind::Github, "github.com", &["octo", "repo"]),
            repo(ado, "dev.azure.com", &["fabrikam", "P", "R"]),
            repo(ado, "dev.azure.com", &["contoso", "Other", "Repo"]),
            repo(ado, "dev.azure.com", &[]),
        ];
        assert_eq!(
            azure_orgs(&["fabrikam".into()], &repos),
            ["fabrikam", "contoso"]
        );
        assert_eq!(azure_orgs(&[], &repos), ["contoso", "fabrikam"]);
        assert!(azure_orgs(&[], &repos[1..2]).is_empty());
    }

    #[test]
    fn no_signals_lists_the_four_public_hosts_undetected() {
        use ProviderKind::{AzureDevOps, Bitbucket, Github, Gitlab};
        assert_eq!(
            listed(&Signals::default()),
            vec![
                row(Github, "github.com", false),
                row(Gitlab, "gitlab.com", false),
                row(Bitbucket, "bitbucket.org", false),
                row(AzureDevOps, "dev.azure.com", false),
            ]
        );
    }

    #[test]
    fn each_signal_alone_detects_its_card() {
        use ProviderKind::{AzureDevOps, Bitbucket, Github, Gitlab};
        let gh = Signals {
            gh_hosts: remote::parse_gh_hosts(SAMPLE_HOSTS_YML),
            ..Default::default()
        };
        assert_eq!(reasons(&gh, "github.com"), vec!["GitHub CLI is signed in"]);
        assert_eq!(
            reasons(&gh, "ghe.example.com"),
            vec!["GitHub CLI is signed in"]
        );
        let glab = Signals {
            glab_hosts: vec!["gitlab.com".into()],
            ..Default::default()
        };
        assert_eq!(
            reasons(&glab, "gitlab.com"),
            vec!["GitLab CLI's config names it"]
        );
        let mut forge_hosts = HashMap::new();
        forge_hosts.insert("git.example.com".to_string(), Gitlab);
        let setting = Signals {
            forge_hosts,
            ..Default::default()
        };
        assert_eq!(
            reasons(&setting, "git.example.com"),
            vec!["the ship.hosts setting"]
        );
        let pin = Signals {
            known: vec![(Github, "github.com".into(), FROM_PIN_OR_PANE)],
            ..Default::default()
        };
        assert_eq!(reasons(&pin, "github.com"), vec![FROM_PIN_OR_PANE]);
        let terminal = Signals {
            known: vec![(Bitbucket, "bitbucket.org".into(), FROM_TERMINAL)],
            ..Default::default()
        };
        assert_eq!(reasons(&terminal, "bitbucket.org"), vec![FROM_TERMINAL]);
        let bb = Signals {
            bitbucket_stored: true,
            ..Default::default()
        };
        assert_eq!(reasons(&bb, "bitbucket.org"), vec!["a stored API token"]);
        for (s, why) in [
            (
                Signals {
                    azure_stored: true,
                    ..Default::default()
                },
                "a stored personal access token",
            ),
            (
                Signals {
                    azure_env: true,
                    ..Default::default()
                },
                "AZURE_DEVOPS_EXT_PAT is set",
            ),
            (
                Signals {
                    az_installed: true,
                    ..Default::default()
                },
                "Azure CLI is installed",
            ),
            (
                Signals {
                    known: vec![(
                        AzureDevOps,
                        "contoso.visualstudio.com".into(),
                        FROM_TERMINAL,
                    )],
                    ..Default::default()
                },
                FROM_TERMINAL,
            ),
        ] {
            assert_eq!(reasons(&s, "dev.azure.com"), vec![why]);
            // One signal marks only its own card.
            let detected: Vec<_> = listed(&s).into_iter().filter(|r| r.2).collect();
            assert_eq!(detected, vec![row(AzureDevOps, "dev.azure.com", true)]);
        }
    }

    #[test]
    fn self_managed_hosts_appear_once_known_and_sort_by_group() {
        use ProviderKind::{AzureDevOps, Bitbucket, Github, Gitlab};
        let none = Signals::default();
        assert!(!listed(&none).iter().any(|r| r.1 == "gitlab.example.com"));
        let mut forge_hosts = HashMap::new();
        forge_hosts.insert("zeta.example.com".to_string(), Github);
        forge_hosts.insert("bitbucket.example.com".to_string(), Bitbucket);
        // A GitHub CLI host that ship.hosts names as GitLab is listed as GitLab only.
        forge_hosts.insert("ghe.example.com".to_string(), Gitlab);
        let s = Signals {
            gh_hosts: remote::parse_gh_hosts(SAMPLE_HOSTS_YML),
            glab_hosts: vec!["gitlab.zz.example".into(), "Gitlab.AA.example".into()],
            forge_hosts,
            known: vec![
                (Gitlab, "gitlab.example.com:8443".into(), FROM_TERMINAL),
                (Github, "Acme.Example.com".into(), FROM_PIN_OR_PANE),
            ],
            ..Default::default()
        };
        assert_eq!(
            listed(&s),
            vec![
                row(Github, "github.com", true),
                row(Github, "acme.example.com", true),
                row(Github, "zeta.example.com", true),
                row(Gitlab, "ghe.example.com", true),
                row(Gitlab, "gitlab.aa.example", true),
                row(Gitlab, "gitlab.com", false),
                row(Gitlab, "gitlab.example.com", true),
                row(Gitlab, "gitlab.zz.example", true),
                row(Bitbucket, "bitbucket.org", false),
                row(AzureDevOps, "dev.azure.com", false),
            ]
        );
        assert_eq!(
            reasons(&s, "ghe.example.com"),
            vec!["the ship.hosts setting"]
        );
        // Two signals on one host give two reasons, each once.
        let both = Signals {
            gh_hosts: vec!["github.com".into(), "github.com".into()],
            known: vec![(Github, "github.com".into(), FROM_TERMINAL)],
            ..Default::default()
        };
        assert_eq!(
            reasons(&both, "github.com"),
            vec!["GitHub CLI is signed in", FROM_TERMINAL]
        );
    }

    #[test]
    fn stored_targets_per_provider() {
        let (t, u, h) = stored_target(ProviderKind::Bitbucket, Some("ignored")).unwrap();
        assert_eq!(
            (t.as_str(), u, h),
            (
                credential_store::BITBUCKET_TARGET,
                credential_store::BITBUCKET_USER,
                "bitbucket.org"
            )
        );
        let (t, u, h) = stored_target(ProviderKind::AzureDevOps, Some("Contoso")).unwrap();
        assert_eq!(
            (t.as_str(), u, h),
            (
                "bashboard:dev.azure.com/contoso",
                credential_store::AZURE_DEVOPS_USER,
                "dev.azure.com"
            )
        );
        assert!(stored_target(ProviderKind::AzureDevOps, None).is_err());
        assert!(stored_target(ProviderKind::AzureDevOps, Some("a/b")).is_err());
        assert!(stored_target(ProviderKind::Github, None).is_err());
        assert!(stored_target(ProviderKind::Gitlab, None).is_err());
    }

    #[test]
    fn source_kinds() {
        let cli = TokenSource::Cli {
            program: "gh".into(),
            args: vec![],
        };
        let gcm = TokenSource::GitCredential {
            host: "github.com".into(),
            username: None,
            path: None,
        };
        let stored = TokenSource::CredentialManager {
            target: credential_store::BITBUCKET_TARGET.into(),
        };
        assert_eq!(source_kind(&cli), TokenSourceKind::GhCli);
        assert_eq!(source_kind(&gcm), TokenSourceKind::GitCredentialManager);
        assert_eq!(source_kind(&stored), TokenSourceKind::BashboardCredential);
        let s = |k: TokenSourceKind| serde_json::to_string(&k).unwrap();
        assert_eq!(s(TokenSourceKind::GhCli), "\"ghCli\"");
        assert_eq!(
            s(TokenSourceKind::GitCredentialManager),
            "\"gitCredentialManager\""
        );
        assert_eq!(
            s(TokenSourceKind::BashboardCredential),
            "\"bashboardCredential\""
        );
        let glab = TokenSource::Glab {
            host: "gitlab.com".into(),
        };
        let env = TokenSource::Env {
            var: "AZURE_DEVOPS_EXT_PAT".into(),
        };
        assert_eq!(source_kind(&glab), TokenSourceKind::GlabCli);
        assert_eq!(source_kind(&TokenSource::AzCli), TokenSourceKind::AzCli);
        assert_eq!(source_kind(&env), TokenSourceKind::Environment);
        assert_eq!(s(TokenSourceKind::GlabCli), "\"glabCli\"");
        assert_eq!(s(TokenSourceKind::AzCli), "\"azCli\"");
        assert_eq!(s(TokenSourceKind::Environment), "\"environment\"");
    }

    #[test]
    fn rejects_a_user_not_signed_in() {
        assert!(check_signed_in(SAMPLE_HOSTS_YML, "github.com", "bob").is_ok());
        assert!(check_signed_in(SAMPLE_HOSTS_YML, "ghe.example.com:8443", "carol").is_ok());
        let e = check_signed_in(SAMPLE_HOSTS_YML, "github.com", "mallory").unwrap_err();
        assert_eq!(
            e.message,
            "mallory isn't signed in to GitHub CLI for github.com."
        );
        assert!(check_signed_in(SAMPLE_HOSTS_YML, "github.com", "carol").is_err());
        assert!(check_signed_in("", "github.com", "alice").is_err());
    }

    #[test]
    fn dto_shapes() {
        let h = HostAuth {
            provider: ProviderKind::AzureDevOps,
            host: "dev.azure.com".into(),
            cli_installed: true,
            accounts: vec!["ann@example.com".into()],
            active_account: Some("ann@example.com".into()),
            token_source: Some(TokenSourceKind::BashboardCredential),
            stored_tokens: vec![StoredToken {
                org: Some("contoso".into()),
            }],
            gh_env_token: None,
            detected: true,
            detected_by: vec!["Azure CLI is installed".into()],
            known_orgs: vec!["contoso".into(), "fabrikam".into()],
        };
        assert_eq!(
            serde_json::to_value(&h).unwrap(),
            serde_json::json!({
                "provider": "azureDevOps",
                "host": "dev.azure.com",
                "cliInstalled": true,
                "accounts": ["ann@example.com"],
                "activeAccount": "ann@example.com",
                "tokenSource": "bashboardCredential",
                "storedTokens": [{ "org": "contoso" }],
                "ghEnvToken": null,
                "detected": true,
                "detectedBy": ["Azure CLI is installed"],
                "knownOrgs": ["contoso", "fabrikam"]
            })
        );
        let k: Known = serde_json::from_value(serde_json::json!({
            "hosts": [{ "provider": "gitlab", "host": "gitlab.com" }],
            "dirs": ["C:/src/app"]
        }))
        .unwrap();
        assert_eq!(
            (k.hosts[0].provider, k.hosts[0].host.as_str(), k.dirs.len()),
            (ProviderKind::Gitlab, "gitlab.com", 1)
        );
        let c = AuthCheck {
            ok: true,
            login: Some("alice".into()),
            scopes: None,
            message: None,
        };
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            serde_json::json!({ "ok": true, "login": "alice", "scopes": null, "message": null })
        );
        let p: ProviderKind = serde_json::from_str("\"github\"").unwrap();
        assert_eq!(p, ProviderKind::Github);
    }

    fn env<'a>(set: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |n| {
            set.iter()
                .find(|(k, _)| *k == n)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn env_token_variable_per_host() {
        let all = [
            ("GH_TOKEN", "a"),
            ("GITHUB_TOKEN", "b"),
            ("GH_ENTERPRISE_TOKEN", "c"),
            ("GITHUB_ENTERPRISE_TOKEN", "d"),
        ];
        assert_eq!(gh_env_token_var("github.com", env(&all)), Some("GH_TOKEN"));
        assert_eq!(
            gh_env_token_var("acme.ghe.com", env(&all)),
            Some("GH_TOKEN")
        );
        assert_eq!(
            gh_env_token_var("ghe.example.com", env(&all)),
            Some("GH_ENTERPRISE_TOKEN")
        );
        assert_eq!(
            gh_env_token_var("ghe.example.com:8443", env(&all)),
            Some("GH_ENTERPRISE_TOKEN")
        );
        // The github.com pair is ignored for Enterprise Server and vice versa.
        assert_eq!(gh_env_token_var("ghe.example.com", env(&all[..2])), None);
        assert_eq!(gh_env_token_var("github.com", env(&all[2..])), None);
        assert_eq!(gh_env_token_var("github.com", env(&[])), None);
    }

    #[test]
    fn env_token_precedence_and_empty_values() {
        let both = [("GITHUB_TOKEN", "b"), ("GH_TOKEN", "a")];
        assert_eq!(gh_env_token_var("github.com", env(&both)), Some("GH_TOKEN"));
        let fallback = [("GH_TOKEN", ""), ("GITHUB_TOKEN", "b")];
        assert_eq!(
            gh_env_token_var("github.com", env(&fallback)),
            Some("GITHUB_TOKEN")
        );
        let empty = [("GH_TOKEN", ""), ("GITHUB_TOKEN", "")];
        assert_eq!(gh_env_token_var("github.com", env(&empty)), None);
        let ent = [
            ("GH_ENTERPRISE_TOKEN", ""),
            ("GITHUB_ENTERPRISE_TOKEN", "d"),
        ];
        assert_eq!(
            gh_env_token_var("ghe.example.com", env(&ent)),
            Some("GITHUB_ENTERPRISE_TOKEN")
        );
    }

    #[test]
    fn logins_and_scopes() {
        let v = serde_json::json!({ "display_name": "Ann", "nickname": "ann" });
        assert_eq!(
            user_login(ProviderKind::Bitbucket, &v).as_deref(),
            Some("Ann")
        );
        let v = serde_json::json!({ "display_name": "", "nickname": "ann" });
        assert_eq!(
            user_login(ProviderKind::Bitbucket, &v).as_deref(),
            Some("ann")
        );
        let v = serde_json::json!({ "username": "gl-user", "name": "GL" });
        assert_eq!(
            user_login(ProviderKind::Gitlab, &v).as_deref(),
            Some("gl-user")
        );
        let v = serde_json::json!({ "authenticatedUser": { "providerDisplayName": "Ann Lee", "id": "x" } });
        assert_eq!(
            user_login(ProviderKind::AzureDevOps, &v).as_deref(),
            Some("Ann Lee")
        );
        assert_eq!(
            user_login(ProviderKind::AzureDevOps, &serde_json::json!({})),
            None
        );
        let v = serde_json::json!({ "login": "octo" });
        assert_eq!(
            user_login(ProviderKind::Github, &v).as_deref(),
            Some("octo")
        );
        let h = vec![("x-oauth-scopes".to_string(), "repo, read:org".to_string())];
        assert_eq!(scopes_of(&h), Some(vec!["repo".into(), "read:org".into()]));
        assert_eq!(scopes_of(&[]), None);
    }
}
