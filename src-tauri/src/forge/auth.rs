//! Finding a token for a code host (docs/design/ship.md section 3.20). Bashboard never runs an
//! OAuth flow: it asks GitHub CLI, GitLab CLI, Azure CLI, an environment variable, Git
//! Credential Manager, or the Bitbucket credential in
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
use crate::lock::LockExt;
use crate::git::Git;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenSource {
    /// A CLI that prints a token, such as `gh auth token --hostname <host>`.
    Cli { program: String, args: Vec<String> },
    /// `git credential fill`, which reaches Git Credential Manager. A `username` makes GCM
    /// return that account's token without showing its account picker.
    /// `path` reaches GCM as a `path=` line: it sets `credential.useHttpPath` for
    /// `dev.azure.com`, so a credential there is stored per organization path.
    GitCredential {
        host: String,
        username: Option<String>,
        path: Option<String>,
    },
    /// A generic credential in Windows Credential Manager.
    CredentialManager { target: String },
    /// An environment variable's trimmed value, such as `AZURE_DEVOPS_EXT_PAT`.
    Env { var: String },
    /// An Entra token for Azure DevOps from `az account get-access-token`.
    AzCli,
    /// `glab auth status --show-token`, since glab has no `auth token` command.
    Glab { host: String },
}

/// The Azure DevOps resource id that `az account get-access-token` mints tokens for.
const AZURE_DEVOPS_RESOURCE: &str = "499b84ac-1321-427f-aa17-267ca6975798";

/// `<program>.exe` (`az.cmd` for `az`) on `PATH`, then the CLI's install folders: a CLI
/// installed while Bashboard runs is not on the `PATH` it inherited until it restarts, the same
/// reason git.rs falls back to the folder beside Git Bash.
pub fn locate_program(program: &str) -> Option<PathBuf> {
    let name = program.strip_suffix(".exe").unwrap_or(program);
    let file = if name == "az" {
        "az.cmd".to_string()
    } else {
        format!("{name}.exe")
    };
    let on_path = std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join(&file))
            .find(|p| p.is_file())
    });
    if on_path.is_some() {
        return on_path;
    }
    let env_dir = |var: &str, rel: &[&str]| {
        std::env::var_os(var).map(|d| rel.iter().fold(PathBuf::from(d), |p, s| p.join(s)))
    };
    let az = ["Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd"];
    let candidates = match name {
        "gh" => vec![
            env_dir("ProgramFiles", &["GitHub CLI", "gh.exe"]),
            env_dir("LOCALAPPDATA", &["Programs", "GitHub CLI", "gh.exe"]),
        ],
        // The 64-bit and 32-bit MSI folders; the MSI does not let the user choose.
        "az" => vec![
            env_dir("ProgramFiles", &az),
            env_dir("ProgramFiles(x86)", &az),
        ],
        // The Inno installer's per-user and machine folders, then winget's links folder.
        "glab" => vec![
            env_dir("LOCALAPPDATA", &["Programs", "glab", "glab.exe"]),
            env_dir("ProgramFiles", &["glab", "glab.exe"]),
            env_dir(
                "LOCALAPPDATA",
                &["Microsoft", "WinGet", "Links", "glab.exe"],
            ),
        ],
        _ => Vec::new(),
    };
    candidates.into_iter().flatten().find(|p| p.is_file())
}

/// Whether `gh` is reachable by name from a new terminal pane, or only by its full path.
pub fn gh_on_path() -> bool {
    std::env::var_os("PATH")
        .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("gh.exe").is_file()))
}

/// Runs a located CLI with no console and no stdin, returning (success, stdout, stderr); `None`
/// when the program isn't found or won't start. A
/// `.cmd` such as `az.cmd` goes through the standard library's batch-file handling, which runs
/// it under `cmd.exe` with safe quoting; a hand-built `cmd /C` mangles a path holding `(x86)`.
fn run_program(program: &str, args: &[String]) -> Option<(bool, String, String)> {
    let exe = locate_program(program)?;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::editors::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

fn run_cli(program: &str, args: &[String]) -> Option<String> {
    let (ok, stdout, _) = run_program(program, args)?;
    let token = stdout.trim().to_string();
    (ok && !token.is_empty()).then_some(token)
}

/// `glab auth status --hostname <host>`'s stdout and stderr together (glab has printed the
/// status to either), without `--show-token`, so the text never holds a token. `None` when
/// glab isn't installed.
pub(crate) fn glab_status(host: &str) -> Option<String> {
    let args = ["auth", "status", "--hostname", host].map(String::from);
    let (_, stdout, stderr) = run_program("glab", &args)?;
    Some(format!("{stdout}\n{stderr}"))
}

/// The user Azure CLI is signed in as, or `None` when it isn't installed or signed in.
pub(crate) fn az_user() -> Option<String> {
    let args = ["account", "show", "--query", "user.name", "-o", "tsv"].map(String::from);
    run_cli("az", &args)
}

/// Runs `glab auth logout --hostname <host>`, which takes no input: it has no confirmation, and
/// the host flag leaves nothing to pick.
pub(crate) fn glab_logout(host: &str) -> Result<(), String> {
    let args = ["auth", "logout", "--hostname", host].map(String::from);
    let (ok, _, stderr) =
        run_program("glab", &args).ok_or_else(|| "GitLab CLI isn't installed.".to_string())?;
    if ok {
        return Ok(());
    }
    let stderr = stderr.trim();
    Err(if stderr.is_empty() {
        "glab auth logout failed.".to_string()
    } else {
        format!("glab auth logout failed: {stderr}")
    })
}

fn env_token(var: &str) -> Option<String> {
    trimmed(&std::env::var(var).ok()?)
}

fn trimmed(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn az_cli() -> Option<(String, Option<Instant>)> {
    let args = [
        "account",
        "get-access-token",
        "--resource",
        AZURE_DEVOPS_RESOURCE,
        "-o",
        "json",
    ]
    .map(String::from);
    let (ok, stdout, _) = run_program("az", &args)?;
    if !ok {
        return None;
    }
    let (token, expires_on) = az_token(&stdout)?;
    let expires = expiry_instant(expires_on);
    let early = expires
        .checked_sub(Duration::from_secs(5 * 60))
        .unwrap_or_else(Instant::now);
    Some((token, Some(early)))
}

/// glab refreshes its OAuth tokens itself, so a copy is kept only briefly.
fn glab_cli(host: &str) -> Option<(String, Option<Instant>)> {
    let args = ["auth", "status", "--hostname", host, "--show-token"].map(String::from);
    let (ok, stdout, stderr) = run_program("glab", &args)?;
    if !ok {
        return None;
    }
    let token = glab_token(&stdout).or_else(|| glab_token(&stderr))?;
    Some((token, Some(Instant::now() + Duration::from_secs(10 * 60))))
}

/// `accessToken` and `expires_on` (epoch seconds) from `az account get-access-token -o json`.
/// Releases before `expires_on` existed have only `expiresOn`, a local time string; then the
/// token is taken to last the hour Entra issues it for.
pub(crate) fn az_token(json: &str) -> Option<(String, u64)> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let token = v.get("accessToken")?.as_str()?.trim();
    if token.is_empty() {
        return None;
    }
    let expires = match v.get("expires_on") {
        Some(e) => e.as_u64().or_else(|| e.as_str()?.trim().parse().ok())?,
        None => SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() + 3600,
    };
    Some((token.to_string(), expires))
}

/// A `glab auth status` line without color codes or its leading status icon.
fn glab_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out.trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim_end()
        .to_string()
}

/// The user from glab's "Logged in to <host> as <user> (<source>)" line for `host`. Reads only
/// that line, never the token line.
pub(crate) fn glab_status_user(text: &str, host: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = glab_line(line);
        let rest = line.strip_prefix("Logged in to ")?;
        let (h, rest) = rest.split_once(" as ")?;
        if !h.trim().eq_ignore_ascii_case(host) {
            return None;
        }
        let user = rest.split_whitespace().next()?;
        Some(user.to_string())
    })
}

/// The token from `glab auth status --show-token`: older releases print "Token: <t>", newer
/// ones "Token found in <where>: <t>". The value follows the last ": ", since <where> can be a
/// Windows path with a drive colon. A masked value (all asterisks) is no token.
pub(crate) fn glab_token(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = glab_line(line);
        if !(line.starts_with("Token:") || line.starts_with("Token found in ")) {
            return None;
        }
        let (_, value) = line.rsplit_once(": ")?;
        let value = value.trim();
        (!value.is_empty() && !value.chars().all(|c| c == '*')).then(|| value.to_string())
    })
}

/// The request `git credential fill` reads on stdin, or `None` when a value would break out of its
/// line: the username can come from a repo's config or remote URL, and a newline in it could add
/// a `host=` line that asks the helper for another host's credential.
pub fn credential_input(host: &str, username: Option<&str>, path: Option<&str>) -> Option<String> {
    let unsafe_value = |v: &str| v.contains(['\n', '\r', '\0']);
    if unsafe_value(host) || username.is_some_and(unsafe_value) || path.is_some_and(unsafe_value) {
        return None;
    }
    let mut s = format!("protocol=https\nhost={host}\n");
    if let Some(p) = path {
        s.push_str(&format!("path={p}\n"));
    }
    if let Some(u) = username {
        s.push_str(&format!("username={u}\n"));
    }
    s.push('\n');
    Some(s)
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

/// How long a credential helper may take before the probe gives up on it.
const CREDENTIAL_TIMEOUT: Duration = Duration::from_secs(15);

/// Git's askpass fallbacks: Git Bash exports `SSH_ASKPASS` (git-askpass.exe), and git falls
/// through to it when a helper has no credential, opening a window nobody is there to answer.
const ASKPASS_VARS: [&str; 2] = ["GIT_ASKPASS", "SSH_ASKPASS"];

/// Arguments of `git credential fill`. An empty `core.askPass` overrides any configured helper.
const CREDENTIAL_ARGS: [&str; 4] = ["-c", "core.askPass=", "credential", "fill"];

/// Environment `git credential fill` runs with: never a prompt of any kind.
const CREDENTIAL_ENV: [(&str, &str); 3] = [
    ("GCM_INTERACTIVE", "never"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("SSH_ASKPASS_REQUIRE", "never"),
];

/// Never `approve` or `reject`: the credential belongs to the user's helper, not to us.
fn git_credential(
    git: &Git,
    host: &str,
    username: Option<&str>,
    path: Option<&str>,
) -> Option<(String, Option<Instant>)> {
    let input = credential_input(host, username, path)?;
    let out = git
        .read_input(
            CREDENTIAL_ARGS,
            input.as_bytes(),
            &CREDENTIAL_ENV,
            &ASKPASS_VARS,
            CREDENTIAL_TIMEOUT,
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
            TokenSource::GitCredential {
                host,
                username,
                path,
            } => git_credential(git, host, username.as_deref(), path.as_deref()),
            TokenSource::CredentialManager { target } => {
                crate::credential_store::read(target).map(|t| (t, None))
            }
            TokenSource::Env { var } => env_token(var).map(|t| (t, None)),
            TokenSource::AzCli => az_cli(),
            TokenSource::Glab { host } => glab_cli(host),
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
        let mut map = self.0.lock_or_recover();
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
        self.0.lock_or_recover().insert(key, token);
    }

    pub fn drop_one(&self, kind: ProviderKind, host: &str, account: Option<&str>) {
        let key = (kind, host.to_string(), account.map(str::to_string));
        self.0.lock_or_recover().remove(&key);
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
    fn credential_fill_can_never_prompt() {
        assert_eq!(&CREDENTIAL_ARGS[..2], ["-c", "core.askPass="]);
        assert_eq!(&CREDENTIAL_ARGS[2..], ["credential", "fill"]);
        assert!(ASKPASS_VARS.contains(&"SSH_ASKPASS"));
        assert!(ASKPASS_VARS.contains(&"GIT_ASKPASS"));
        assert!(CREDENTIAL_ENV.contains(&("GIT_TERMINAL_PROMPT", "0")));
        assert!(CREDENTIAL_ENV.contains(&("GCM_INTERACTIVE", "never")));
    }

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
            credential_input("github.com", None, None).as_deref(),
            Some("protocol=https\nhost=github.com\n\n")
        );
        assert_eq!(
            credential_input("github.com", Some("bob"), None).as_deref(),
            Some("protocol=https\nhost=github.com\nusername=bob\n\n")
        );
        assert_eq!(
            credential_input("dev.azure.com", None, Some("contoso")).as_deref(),
            Some("protocol=https\nhost=dev.azure.com\npath=contoso\n\n")
        );
        assert_eq!(credential_input("github.com", Some("bob\nhost=evil.example"), None), None);
        assert_eq!(credential_input("github.com", Some("bob\r"), None), None);
        assert_eq!(credential_input("github.com", None, Some("org\0")), None);
        assert_eq!(credential_input("github.com\nhost=x", None, None), None);
        let out = "protocol=https\nhost=github.com\nusername=bob\npassword=fake-pass\npassword_expiry_utc=1700000000\n";
        assert_eq!(
            parse_credential_output(out),
            Some(("fake-pass".into(), Some(1_700_000_000)))
        );
        assert_eq!(parse_credential_output("protocol=https\n"), None);
        assert_eq!(parse_credential_output("password=\n"), None);
    }

    /// `glab auth status --show-token` output from an older release (with color) and a newer
    /// one; the tokens are fake.
    const GLAB_STATUS_OLD: &str = "\
gitlab.com
  \u{1b}[0;32m\u{2713}\u{1b}[0m Logged in to gitlab.com as \u{1b}[1malice\u{1b}[0m (C:\\Users\\alice\\.config\\glab-cli\\config.yml)
  \u{2713} Git operations for gitlab.com configured to use ssh protocol.
  \u{2713} REST API Endpoint: https://gitlab.com/api/v4/
  \u{2713} Token: glpat-FAKEoldToken000
";
    const GLAB_STATUS_NEW: &str = "\
gitlab.example.com
  \u{2713} Logged in to gitlab.example.com as bob (keyring)
  \u{2713} REST API Endpoint: https://gitlab.example.com/api/v4/
  \u{2713} Token found in config file C:\\Users\\bob\\AppData\\Local\\glab-cli\\config.yml: glpat-FAKEnewToken000
";

    #[test]
    fn glab_status_parsers() {
        assert_eq!(
            glab_status_user(GLAB_STATUS_OLD, "GitLab.com").as_deref(),
            Some("alice")
        );
        assert_eq!(
            glab_status_user(GLAB_STATUS_NEW, "gitlab.example.com").as_deref(),
            Some("bob")
        );
        assert_eq!(glab_status_user(GLAB_STATUS_NEW, "gitlab.com"), None);
        assert_eq!(
            glab_token(GLAB_STATUS_OLD).as_deref(),
            Some("glpat-FAKEoldToken000")
        );
        assert_eq!(
            glab_token(GLAB_STATUS_NEW).as_deref(),
            Some("glpat-FAKEnewToken000")
        );
        assert_eq!(
            glab_token("  \u{2713} Token found in keyring: ********\n"),
            None
        );
        assert_eq!(glab_token("  \u{2713} Token: ********\n"), None);
        let env = "! Token is from environment variable GITLAB_TOKEN. This takes precedence.\n";
        assert_eq!(glab_token(env), None);
        assert_eq!(glab_token(""), None);
    }

    #[test]
    fn glab_user_never_holds_a_token() {
        for (text, host) in [
            (GLAB_STATUS_OLD, "gitlab.com"),
            (GLAB_STATUS_NEW, "gitlab.example.com"),
        ] {
            let user = glab_status_user(text, host).unwrap_or_default();
            assert!(!user.contains("glpat"), "{user}");
        }
    }

    #[test]
    fn az_token_parses() {
        let json = r#"{
  "accessToken": "eyFAKE.az.token",
  "expiresOn": "2026-11-05 13:00:00.000000",
  "expires_on": 1793970000,
  "subscription": "00000000-0000-0000-0000-000000000000",
  "tenant": "00000000-0000-0000-0000-000000000000",
  "tokenType": "Bearer"
}"#;
        assert_eq!(
            az_token(json),
            Some(("eyFAKE.az.token".into(), 1_793_970_000))
        );
        assert_eq!(
            az_token(r#"{"accessToken": "t", "expires_on": "1793970000"}"#),
            Some(("t".into(), 1_793_970_000))
        );
        assert!(az_token(r#"{"accessToken": "t", "expiresOn": "x"}"#).is_some());
        assert_eq!(az_token(r#"{"accessToken": "", "expires_on": 1}"#), None);
        assert_eq!(
            az_token("ERROR: Please run 'az login' to setup account."),
            None
        );
    }

    #[test]
    fn env_source_reads_a_trimmed_value() {
        assert_eq!(trimmed("  fake-pat \r\n").as_deref(), Some("fake-pat"));
        assert_eq!(trimmed("   "), None);
        assert_eq!(env_token("BASHBOARD_TEST_UNSET_TOKEN_VARIABLE"), None);
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
