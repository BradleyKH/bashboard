//! Finding a token for a code host (docs/design.md section 3.20). Bashboard never runs an
//! OAuth flow: it asks GitHub CLI, Git Credential Manager, or the Bitbucket credential in
//! Windows Credential Manager that `bb auth bitbucket` or the Accounts tab stores
//! (`crate::credential_store`). Tokens stay in this process's memory, are never serialized or
//! logged, and never reach the page. The one inbound path is the Accounts tab's Bitbucket token
//! field: that token arrives as one command argument, goes only to Credential Manager, and the
//! core's copy is overwritten after the write (best effort).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::types::{AccountSource, ForgeError, ForgeErrorKind, ProviderKind, Token};
use crate::git::Git;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenSource {
    /// A CLI that prints a token, such as `gh auth token --hostname <host>`.
    Cli { program: String, args: Vec<String> },
    /// `git credential fill`, which reaches Git Credential Manager. A `username` makes GCM
    /// return that account's token without showing its account picker.
    GitCredential {
        host: String,
        username: Option<String>,
    },
    /// A generic credential in Windows Credential Manager.
    CredentialManager { target: String },
}

/// `<program>.exe` on `PATH`, then GitHub CLI's install folders for `gh`: a `gh` installed while
/// Bashboard runs is not on the `PATH` it inherited until it restarts, the same reason git.rs
/// falls back to the folder beside Git Bash.
pub fn locate_program(program: &str) -> Option<PathBuf> {
    let exe = if program.ends_with(".exe") {
        program.to_string()
    } else {
        format!("{program}.exe")
    };
    let on_path = std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join(&exe))
            .find(|p| p.is_file())
    });
    if on_path.is_some() || program != "gh" {
        return on_path;
    }
    let env_dir = |var: &str, rel: &[&str]| {
        std::env::var_os(var).map(|d| rel.iter().fold(PathBuf::from(d), |p, s| p.join(s)))
    };
    [
        env_dir("ProgramFiles", &["GitHub CLI", "gh.exe"]),
        env_dir("LOCALAPPDATA", &["Programs", "GitHub CLI", "gh.exe"]),
    ]
    .into_iter()
    .flatten()
    .find(|p| p.is_file())
}

/// Whether `gh` is reachable by name from a new terminal pane, or only by its full path.
pub fn gh_on_path() -> bool {
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("gh.exe").is_file()))
}

fn run_cli(program: &str, args: &[String]) -> Option<String> {
    let exe = locate_program(program)?;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::editors::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

pub fn credential_input(host: &str, username: Option<&str>) -> String {
    let mut s = format!("protocol=https\nhost={host}\n");
    if let Some(u) = username {
        s.push_str(&format!("username={u}\n"));
    }
    s.push('\n');
    s
}

/// `password=` and `password_expiry_utc=` from `git credential fill`'s output.
pub fn parse_credential_output(text: &str) -> Option<(String, Option<u64>)> {
    let mut password = None;
    let mut expiry = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("password=") {
            password = Some(p.trim_end_matches('\r').to_string());
        } else if let Some(e) = line.strip_prefix("password_expiry_utc=") {
            expiry = e.trim().parse::<u64>().ok();
        }
    }
    password.filter(|p| !p.is_empty()).map(|p| (p, expiry))
}

fn expiry_instant(epoch: u64) -> Instant {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Instant::now() + Duration::from_secs(epoch.saturating_sub(now))
}

/// Never `approve` or `reject`: the credential belongs to the user's helper, not to us.
fn git_credential(
    git: &Git,
    host: &str,
    username: Option<&str>,
) -> Option<(String, Option<Instant>)> {
    let input = credential_input(host, username);
    let out = git
        .read_input(
            ["credential", "fill"],
            input.as_bytes(),
            &[("GCM_INTERACTIVE", "never"), ("GIT_TERMINAL_PROMPT", "0")],
        )
        .ok()?;
    if !out.ok {
        return None;
    }
    let (password, expiry) = parse_credential_output(&String::from_utf8_lossy(&out.stdout))?;
    Some((password, expiry.map(expiry_instant)))
}

/// Tries each source in order and returns the first token found.
pub fn resolve(git: &Git, sources: &[TokenSource]) -> Result<Token, ForgeError> {
    for source in sources {
        let found = match source {
            TokenSource::Cli { program, args } => run_cli(program, args).map(|t| (t, None)),
            TokenSource::GitCredential { host, username } => {
                git_credential(git, host, username.as_deref())
            }
            TokenSource::CredentialManager { target } => {
                crate::credential_store::read(target).map(|t| (t, None))
            }
        };
        if let Some((value, expires)) = found {
            return Ok(Token {
                value,
                source: source.clone(),
                expires,
            });
        }
    }
    Err(ForgeError::new(
        ForgeErrorKind::SignedOut,
        "No sign-in was found for this code host.",
    ))
}

type TokenKey = (ProviderKind, String, Option<String>);

/// Tokens by (provider, host, account), in memory only.
#[derive(Default)]
pub struct TokenCache(Mutex<HashMap<TokenKey, Token>>);

impl TokenCache {
    pub fn get(&self, kind: ProviderKind, host: &str, account: Option<&str>) -> Option<Token> {
        let mut map = self.0.lock().unwrap();
        let key = (kind, host.to_string(), account.map(str::to_string));
        match map.get(&key) {
            Some(t) if t.is_expired() => {
                map.remove(&key);
                None
            }
            other => other.cloned(),
        }
    }

    pub fn put(&self, kind: ProviderKind, host: &str, account: Option<&str>, token: Token) {
        let key = (kind, host.to_string(), account.map(str::to_string));
        self.0.lock().unwrap().insert(key, token);
    }

    pub fn drop_one(&self, kind: ProviderKind, host: &str, account: Option<&str>) {
        let key = (kind, host.to_string(), account.map(str::to_string));
        self.0.lock().unwrap().remove(&key);
    }

    pub fn drop_host(&self, kind: ProviderKind, host: &str) {
        self.0
            .lock()
            .unwrap()
            .retain(|(k, h, _), _| !(*k == kind && h == host));
    }
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .unwrap_or(s)
}

fn yaml_key(line: &str) -> Option<(&str, &str)> {
    let (k, v) = line.trim().split_once(':')?;
    Some((unquote(k), unquote(v)))
}

/// The accounts signed in to `host` and the active one, from GitHub CLI's `hosts.yml`: the
/// host's `users:` children and its `user:` value. Only those keys' names and values are read,
/// never an `oauth_token`.
pub fn gh_accounts(hosts_yml: &str, host: &str) -> (Vec<String>, Option<String>) {
    let lines: Vec<&str> = hosts_yml
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .collect();
    let Some(start) = lines.iter().position(|l| {
        indent(l) == 0 && yaml_key(l).is_some_and(|(k, _)| k.eq_ignore_ascii_case(host))
    }) else {
        return (Vec::new(), None);
    };
    let block: Vec<&str> = lines[start + 1..]
        .iter()
        .take_while(|l| indent(l) > 0)
        .copied()
        .collect();
    let Some(child) = block.first().map(|l| indent(l)) else {
        return (Vec::new(), None);
    };
    let mut users = Vec::new();
    let mut active = None;
    let mut i = 0;
    while i < block.len() {
        let line = block[i];
        if indent(line) == child {
            match yaml_key(line) {
                Some(("user", v)) if !v.is_empty() => active = Some(v.to_string()),
                Some(("users", _)) => {
                    let mut j = i + 1;
                    let grand = block.get(j).map(|l| indent(l)).filter(|&n| n > child);
                    if let Some(grand) = grand {
                        while j < block.len() && indent(block[j]) > child {
                            if indent(block[j]) == grand {
                                if let Some((name, _)) = yaml_key(block[j]) {
                                    if !name.is_empty() {
                                        users.push(name.to_string());
                                    }
                                }
                            }
                            j += 1;
                        }
                    }
                    i = j;
                    continue;
                }
                _ => {}
            }
        }
        i += 1;
    }
    // Single-account configs from before GitHub CLI 2.40 have only `user:`.
    if users.is_empty() {
        if let Some(a) = &active {
            users.push(a.clone());
        }
    }
    (users, active)
}

/// Applies the order `AccountSource` documents.
pub fn choose_account(
    repo_config_user: Option<&str>,
    remote_url_user: Option<&str>,
    accounts: &[String],
    active: Option<&str>,
) -> (Option<String>, AccountSource) {
    let some = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if let Some(u) = some(repo_config_user) {
        return (Some(u), AccountSource::RepoConfig);
    }
    if let Some(u) = some(remote_url_user) {
        return (Some(u), AccountSource::RemoteUrl);
    }
    match accounts {
        [only] => (Some(only.clone()), AccountSource::Only),
        [_, _, ..] => match some(active) {
            Some(a) => (Some(a), AccountSource::CliActive),
            None => (None, AccountSource::None),
        },
        [] => (None, AccountSource::None),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Two users on github.com and one on a GHES host; the token values are fake.
    pub(crate) const SAMPLE_HOSTS_YML: &str = "\
github.com:
    git_protocol: https
    users:
        alice:
            oauth_token: gho_FAKEaliceToken000
        bob:
    user: alice
    oauth_token: gho_FAKEaliceToken000
ghe.example.com:
    users:
        carol:
    git_protocol: ssh
    user: carol
";

    #[test]
    fn reads_accounts_per_host() {
        let (users, active) = gh_accounts(SAMPLE_HOSTS_YML, "github.com");
        assert_eq!(users, vec!["alice", "bob"]);
        assert_eq!(active.as_deref(), Some("alice"));
        let (users, active) = gh_accounts(SAMPLE_HOSTS_YML, "GHE.example.com");
        assert_eq!(users, vec!["carol"]);
        assert_eq!(active.as_deref(), Some("carol"));
        assert_eq!(gh_accounts(SAMPLE_HOSTS_YML, "gitlab.com"), (vec![], None));
        assert_eq!(gh_accounts("", "github.com"), (vec![], None));
    }

    #[test]
    fn accounts_never_hold_a_token() {
        for host in ["github.com", "ghe.example.com"] {
            let (users, active) = gh_accounts(SAMPLE_HOSTS_YML, host);
            let all = format!("{users:?}{active:?}");
            assert!(!all.contains("gho_"), "{all}");
            assert!(!all.contains("oauth_token"), "{all}");
        }
    }

    #[test]
    fn single_account_legacy_config() {
        let yml =
            "github.com:\n    oauth_token: gho_FAKE\n    user: solo\n    git_protocol: https\n";
        assert_eq!(
            gh_accounts(yml, "github.com"),
            (vec!["solo".to_string()], Some("solo".into()))
        );
    }

    #[test]
    fn choose_account_each_source() {
        let two = vec!["alice".to_string(), "bob".to_string()];
        let one = vec!["alice".to_string()];
        assert_eq!(
            choose_account(Some("bob"), Some("x"), &two, Some("alice")),
            (Some("bob".into()), AccountSource::RepoConfig)
        );
        assert_eq!(
            choose_account(None, Some("bob"), &two, Some("alice")),
            (Some("bob".into()), AccountSource::RemoteUrl)
        );
        assert_eq!(
            choose_account(Some(" "), None, &two, Some("alice")),
            (Some("alice".into()), AccountSource::CliActive)
        );
        assert_eq!(
            choose_account(None, None, &one, Some("alice")),
            (Some("alice".into()), AccountSource::Only)
        );
        assert_eq!(
            choose_account(None, None, &two, None),
            (None, AccountSource::None)
        );
        assert_eq!(
            choose_account(None, None, &[], Some("alice")),
            (None, AccountSource::None)
        );
    }

    #[test]
    fn credential_io() {
        assert_eq!(
            credential_input("github.com", None),
            "protocol=https\nhost=github.com\n\n"
        );
        assert_eq!(
            credential_input("github.com", Some("bob")),
            "protocol=https\nhost=github.com\nusername=bob\n\n"
        );
        let out = "protocol=https\nhost=github.com\nusername=bob\npassword=fake-pass\npassword_expiry_utc=1700000000\n";
        assert_eq!(
            parse_credential_output(out),
            Some(("fake-pass".into(), Some(1_700_000_000)))
        );
        assert_eq!(parse_credential_output("protocol=https\n"), None);
        assert_eq!(parse_credential_output("password=\n"), None);
    }

    #[test]
    fn token_cache_drops_by_host() {
        let c = TokenCache::default();
        let t = Token {
            value: "fake".into(),
            source: TokenSource::CredentialManager { target: "x".into() },
            expires: None,
        };
        c.put(ProviderKind::Github, "github.com", Some("a"), t.clone());
        c.put(ProviderKind::Github, "github.com", Some("b"), t.clone());
        c.put(ProviderKind::Github, "ghe.example.com", None, t.clone());
        assert!(
            c.get(ProviderKind::Github, "github.com", Some("a"))
                .is_some()
        );
        c.drop_host(ProviderKind::Github, "github.com");
        assert!(
            c.get(ProviderKind::Github, "github.com", Some("b"))
                .is_none()
        );
        assert!(
            c.get(ProviderKind::Github, "ghe.example.com", None)
                .is_some()
        );
        let past = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let expired = Token {
            expires: Some(past),
            ..t
        };
        c.put(ProviderKind::Bitbucket, "bitbucket.org", None, expired);
        assert!(
            c.get(ProviderKind::Bitbucket, "bitbucket.org", None)
                .is_none()
        );
    }
}
