//! The Accounts tab's commands: which credential the Forge pane would use for each host, a
//! sign-in check, the Bitbucket token, and GitHub CLI's account switch and sign-out. Token
//! values stay in the core; only the Bitbucket token field sends one in (see `auth`).

use std::collections::{BTreeSet, HashMap};
use std::process::{Command, Stdio};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::auth::{self, TokenSource};
use super::types::{
    AuthChanged, AuthCheck, ForgeError, ForgeErrorKind, HostAuth, ProviderKind, RepoRef,
    TokenSourceKind,
};
use super::{
    ForgeState, bare_host, blocking, forge_hosts, github, home_git, remote, token_sources,
};
use crate::credential_store;
use crate::settings::SettingsState;

const BITBUCKET_HOST: &str = "bitbucket.org";
const BITBUCKET_USER_URL: &str = "https://api.bitbucket.org/2.0/user";

/// The hosts the tab lists: `github.com`, the other GitHub hosts from `hosts.yml` and
/// `forge.hosts` alphabetically, then `bitbucket.org`. A `hosts.yml` host that `forge.hosts`
/// maps to another provider is left out, since the pane would not treat it as GitHub.
pub(crate) fn listed_hosts(
    gh_hosts: &[String],
    forge_hosts: &HashMap<String, ProviderKind>,
) -> Vec<(ProviderKind, String)> {
    let others: BTreeSet<String> = gh_hosts
        .iter()
        .map(|h| h.to_ascii_lowercase())
        .filter(|h| {
            forge_hosts
                .get(h)
                .is_none_or(|k| *k == ProviderKind::Github)
        })
        .chain(
            forge_hosts
                .iter()
                .filter(|(_, k)| **k == ProviderKind::Github)
                .map(|(h, _)| h.to_ascii_lowercase()),
        )
        .filter(|h| !h.is_empty() && h != "github.com" && h != BITBUCKET_HOST)
        .collect();
    std::iter::once((ProviderKind::Github, "github.com".to_string()))
        .chain(others.into_iter().map(|h| (ProviderKind::Github, h)))
        .chain(std::iter::once((
            ProviderKind::Bitbucket,
            BITBUCKET_HOST.to_string(),
        )))
        .collect()
}

pub(crate) fn source_kind(source: &TokenSource) -> TokenSourceKind {
    match source {
        TokenSource::Cli { .. } => TokenSourceKind::GhCli,
        TokenSource::GitCredential { .. } => TokenSourceKind::GitCredentialManager,
        TokenSource::CredentialManager { .. } => TokenSourceKind::BashboardCredential,
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

#[tauri::command]
pub async fn forge_auth_status(app: AppHandle) -> Result<Vec<HostAuth>, ForgeError> {
    blocking(move || {
        let settings = app.state::<SettingsState>();
        let git = home_git(&settings)?;
        let hosts_yml = remote::read_gh_hosts_yml().unwrap_or_default();
        let hosts = listed_hosts(&remote::parse_gh_hosts(&hosts_yml), &forge_hosts(&settings));
        let gh_installed = auth::locate_program("gh").is_some();
        let status = |(kind, host): &(ProviderKind, String)| {
            let (accounts, active) = match kind {
                ProviderKind::Github => auth::gh_accounts(&hosts_yml, bare_host(host)),
                _ => (Vec::new(), None),
            };
            // Only the source's kind leaves this closure; the token is dropped here.
            let token_source = auth::resolve(&git, &token_sources(*kind, host, active.as_deref()))
                .ok()
                .map(|t| source_kind(&t.source));
            HostAuth {
                provider: *kind,
                host: host.clone(),
                gh_installed,
                accounts,
                active_account: active,
                token_source,
                bitbucket_token_stored: *kind == ProviderKind::Bitbucket
                    && credential_store::exists(credential_store::BITBUCKET_TARGET),
                gh_env_token: match kind {
                    ProviderKind::Github => gh_env_token_var(host, process_env).map(str::to_string),
                    _ => None,
                },
            }
        };
        // Each host runs gh and git credential fill, so they go side by side.
        Ok(std::thread::scope(|s| {
            let handles: Vec<_> = hosts.iter().map(|h| s.spawn(move || status(h))).collect();
            handles
                .into_iter()
                .zip(&hosts)
                .map(|(t, h)| {
                    t.join().unwrap_or_else(|_| HostAuth {
                        provider: h.0,
                        host: h.1.clone(),
                        gh_installed,
                        accounts: Vec::new(),
                        active_account: None,
                        token_source: None,
                        bitbucket_token_stored: false,
                        gh_env_token: None,
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
        _ => field("login"),
    }
}

/// Asks the host who the token for `account` on `host` belongs to. Errors come back as
/// `ok: false` with the message, so the tab shows them beside the host.
#[tauri::command]
pub async fn forge_auth_test(
    app: AppHandle,
    provider: ProviderKind,
    host: String,
    account: Option<String>,
) -> Result<AuthCheck, ForgeError> {
    blocking(move || {
        if !matches!(provider, ProviderKind::Github | ProviderKind::Bitbucket) {
            return Err(ForgeError::other(format!(
                "{} isn't supported yet",
                provider.display_name()
            )));
        }
        let host = host.trim().to_ascii_lowercase();
        let git = home_git(&app.state::<SettingsState>())?;
        let token = match auth::resolve(&git, &token_sources(provider, &host, account.as_deref())) {
            Ok(t) => t,
            Err(e) => return Ok(failed(e)),
        };
        let (url, accept) = match provider {
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
                )
            }
            _ => (BITBUCKET_USER_URL.to_string(), "application/json"),
        };
        let bearer = format!("Bearer {}", token.value);
        let reply = app
            .state::<ForgeState>()
            .http
            .get_json_with_headers::<Value>(&url, Some(&bearer), &[("Accept", accept)]);
        let reply = match provider {
            ProviderKind::Bitbucket => {
                reply.map_err(|e| super::bitbucket::reword(e, &token.source))
            }
            _ => reply,
        };
        Ok(match reply {
            Ok((body, headers)) => AuthCheck {
                ok: true,
                login: user_login(provider, &body),
                scopes: scopes_of(&headers),
                message: None,
            },
            Err(e) => failed(e),
        })
    })
    .await
}

/// Stores the Bitbucket token in Windows Credential Manager. The token never appears in an
/// error, and both copies are overwritten before they are freed.
#[tauri::command]
pub async fn forge_bitbucket_set_token(app: AppHandle, token: String) -> Result<(), ForgeError> {
    blocking(move || {
        let cleaned = credential_store::clean_token(&token);
        credential_store::wipe(token);
        let cleaned =
            cleaned.map_err(|e| ForgeError::other(format!("Could not store it: {e}.")))?;
        let written = credential_store::write(
            credential_store::BITBUCKET_TARGET,
            credential_store::BITBUCKET_USER,
            cleaned.as_bytes(),
        );
        credential_store::wipe(cleaned);
        written.map_err(|e| ForgeError::other(format!("Could not store it: {e}.")))?;
        auth_changed(&app, ProviderKind::Bitbucket, BITBUCKET_HOST);
        Ok(())
    })
    .await
}

/// False when no token was stored.
#[tauri::command]
pub async fn forge_bitbucket_clear_token(app: AppHandle) -> Result<bool, ForgeError> {
    blocking(move || {
        let removed = credential_store::delete(credential_store::BITBUCKET_TARGET)
            .map_err(|e| ForgeError::other(format!("Could not remove it: {e}.")))?;
        if removed {
            auth_changed(&app, ProviderKind::Bitbucket, BITBUCKET_HOST);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::auth::tests::SAMPLE_HOSTS_YML;

    fn hosts(list: &[(ProviderKind, &str)]) -> Vec<(ProviderKind, String)> {
        list.iter().map(|(k, h)| (*k, h.to_string())).collect()
    }

    #[test]
    fn host_list_and_order() {
        use ProviderKind::{Bitbucket, Github, Gitlab};
        let none = HashMap::new();
        assert_eq!(
            listed_hosts(&[], &none),
            hosts(&[(Github, "github.com"), (Bitbucket, "bitbucket.org")])
        );
        let gh = remote::parse_gh_hosts(SAMPLE_HOSTS_YML);
        let mut settings = HashMap::new();
        settings.insert("zeta.example.com".to_string(), Github);
        settings.insert("Acme.Example.com".to_string(), Github);
        settings.insert("GHE.example.com".to_string(), Github);
        settings.insert("gitlab.example.com".to_string(), Gitlab);
        settings.insert("bitbucket.example.com".to_string(), Bitbucket);
        assert_eq!(
            listed_hosts(&gh, &settings),
            hosts(&[
                (Github, "github.com"),
                (Github, "acme.example.com"),
                (Github, "ghe.example.com"),
                (Github, "zeta.example.com"),
                (Bitbucket, "bitbucket.org"),
            ])
        );
        // A hosts.yml host the settings name as another provider is not listed as GitHub.
        let mut remapped = HashMap::new();
        remapped.insert("ghe.example.com".to_string(), Gitlab);
        assert_eq!(
            listed_hosts(&gh, &remapped),
            hosts(&[(Github, "github.com"), (Bitbucket, "bitbucket.org")])
        );
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
            provider: ProviderKind::Bitbucket,
            host: "bitbucket.org".into(),
            gh_installed: true,
            accounts: vec![],
            active_account: None,
            token_source: Some(TokenSourceKind::BashboardCredential),
            bitbucket_token_stored: true,
            gh_env_token: None,
        };
        assert_eq!(
            serde_json::to_value(&h).unwrap(),
            serde_json::json!({
                "provider": "bitbucket",
                "host": "bitbucket.org",
                "ghInstalled": true,
                "accounts": [],
                "activeAccount": null,
                "tokenSource": "bashboardCredential",
                "bitbucketTokenStored": true,
                "ghEnvToken": null
            })
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
