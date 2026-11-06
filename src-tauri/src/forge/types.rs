//! The normalized shapes every forge provider returns (docs/design/ship.md section 3.20). They
//! serialize camelCase and `src/forgeApi.ts` mirrors them field for field.

use std::fmt;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::auth::TokenSource;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Github,
    Bitbucket,
    Gitlab,
    AzureDevOps,
}

impl ProviderKind {
    /// A `ship.hosts` value; the settings loader has already dropped unknown ones.
    pub fn from_setting(s: &str) -> Option<Self> {
        match s {
            "github" => Some(Self::Github),
            "bitbucket" => Some(Self::Bitbucket),
            "gitlab" => Some(Self::Gitlab),
            "azureDevOps" => Some(Self::AzureDevOps),
            _ => None,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Github => "GitHub",
            Self::Bitbucket => "Bitbucket",
            Self::Gitlab => "GitLab",
            Self::AzureDevOps => "Azure DevOps",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    /// A person must act: GitHub `action_required`, Bitbucket `PAUSED` or `HALTED`.
    Waiting,
    Success,
    Failure,
    Cancelled,
    Skipped,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    Pending,
}

/// Where a pull request stands. Bitbucket's declined and superseded both read as closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PullState {
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub rerun: bool,
    pub rerun_failed: bool,
    pub cancel: bool,
    pub job_logs: bool,
    pub drafts: bool,
    /// "pull request" or "merge request".
    pub pr_noun: String,
    /// "workflow run", "pipeline", or "build".
    pub run_noun: String,
    pub min_poll_secs: u32,
    /// The host can hold several signed-in accounts the user picks between.
    pub accounts: bool,
}

/// How `ForgeRepo::account` was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountSource {
    /// The repo's `credential.username` (local, or `credential.<url>.username`).
    RepoConfig,
    /// A `user@` in the remote URL.
    RemoteUrl,
    /// `gh`'s active account for the host, when several are signed in.
    CliActive,
    /// The only account signed in to the host.
    Only,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepo {
    pub provider: ProviderKind,
    pub host: String,
    pub owner: String,
    pub name: String,
    pub web_url: String,
    /// The current local branch; `None` when HEAD is detached or the repo has no local clone.
    pub branch: Option<String>,
    pub capabilities: Capabilities,
    pub account: Option<String>,
    pub account_source: AccountSource,
    /// Every account signed in to this host, from gh's `hosts.yml`; empty when not applicable.
    pub accounts: Vec<String>,
}

/// Times are ISO 8601.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub number: Option<u64>,
    /// The workflow or pipeline name.
    pub name: String,
    /// The commit message's first line, or the host's display title.
    pub title: String,
    pub branch: Option<String>,
    pub sha: Option<String>,
    pub event: Option<String>,
    pub status: RunStatus,
    pub raw_status: String,
    pub actor: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub web_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub number: u32,
    pub name: String,
    pub status: RunStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub name: String,
    pub status: RunStatus,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub web_url: Option<String>,
    pub steps: Vec<Step>,
}

/// The last 1 MiB of a job's log when it is longer, with `truncated` set.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLog {
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub login: String,
    pub state: ReviewState,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    pub draft: bool,
    pub state: PullState,
    pub source_branch: String,
    pub target_branch: String,
    pub created_at: String,
    pub updated_at: String,
    pub web_url: String,
    pub review_decision: Option<ReviewState>,
    pub reviewers: Vec<Reviewer>,
    pub checks: Option<RunStatus>,
    /// `checks` is not known yet; `forge_pull_checks` fills it in after the list shows.
    pub checks_pending: bool,
    pub is_mine: bool,
    /// The viewer is a requested reviewer who has not reviewed yet.
    pub review_requested: bool,
}

/// A pull request whose checks the front end wants, with the `updated_at` the list gave it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullChecksQuery {
    pub id: String,
    pub updated_at: String,
}

/// One pull request's checks, answering a `PullChecksQuery`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullChecks {
    pub id: String,
    pub checks: Option<RunStatus>,
}

/// One page of pull requests (open ones, or every state) plus the host's count of all that match.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullList {
    pub items: Vec<PullRequest>,
    /// The host's count of the pull requests the query matched; `None` when the host does not say.
    pub total: Option<u64>,
}

/// One row of the Overview tab: the repo, its default branch, its newest runs on every branch,
/// and its open pull requests.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewRepo {
    pub repo: ForgeRepo,
    /// `None` when the host does not say or the lookup failed.
    pub default_branch: Option<String>,
    pub runs: Vec<Run>,
    pub pulls: PullList,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForgeErrorKind {
    NotARepo,
    NoRemote,
    UnsupportedHost,
    NotInstalled,
    SignedOut,
    SsoRequired,
    Forbidden,
    NotFound,
    RateLimited,
    Network,
    Other,
}

/// `message` is plain user-facing text and never holds a token or an Authorization header.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeError {
    pub kind: ForgeErrorKind,
    pub message: String,
    pub url: Option<String>,
    /// The argv to run in a new terminal pane to sign in.
    pub sign_in: Option<Vec<String>>,
    pub retry_after_secs: Option<u64>,
    /// Whether Azure CLI is installed, set only on Azure DevOps errors so the notice offers
    /// Azure CLI sign-in only when it can run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub az_cli: Option<bool>,
}

impl ForgeError {
    pub fn new(kind: ForgeErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            url: None,
            sign_in: None,
            retry_after_secs: None,
            az_cli: None,
        }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new(ForgeErrorKind::Other, message)
    }

    pub fn not_implemented() -> Self {
        Self::other("not implemented")
    }
}

/// Where the token the Ship pane would use for a host comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenSourceKind {
    GhCli,
    GitCredentialManager,
    /// A token Bashboard stored in Windows Credential Manager (Bitbucket's, or an Azure DevOps
    /// organization's).
    BashboardCredential,
    GlabCli,
    AzCli,
    /// A token from an environment variable such as `AZURE_DEVOPS_EXT_PAT`.
    Environment,
}

/// A token Bashboard stored for a host; `org` is the Azure DevOps organization, `None` for
/// Bitbucket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredToken {
    pub org: Option<String>,
}

/// One host's sign-in state for the Accounts tab. Never carries a token.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAuth {
    pub provider: ProviderKind,
    pub host: String,
    /// Whether the provider's CLI (gh, glab, or az) was found; false for Bitbucket.
    pub cli_installed: bool,
    /// The accounts the CLI holds for the host: several for gh, at most one for glab and az.
    pub accounts: Vec<String>,
    pub active_account: Option<String>,
    /// `None` when no source has a token.
    pub token_source: Option<TokenSourceKind>,
    /// One per Azure DevOps organization, at most one for Bitbucket, none for the others.
    pub stored_tokens: Vec<StoredToken>,
    /// Name (never the value) of the environment variable GitHub CLI would use for the host
    /// instead of its saved accounts; `None` for other providers and when none is set.
    pub gh_env_token: Option<String>,
    /// Some signal says the host is used on this machine.
    pub detected: bool,
    /// Human-readable reasons behind `detected`; empty when undetected.
    pub detected_by: Vec<String>,
    /// Azure DevOps organizations known from stored tokens, pins, Ship panes, and terminal
    /// folders, so the card can test each; empty for other providers.
    pub known_orgs: Vec<String>,
}

/// A host the front end knows a repo on: a pin or an open Ship pane.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub provider: ProviderKind,
    pub host: String,
}

/// What the front end knows that the core does not: pin and Ship pane hosts, and the folders
/// open terminal panes are in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Known {
    #[serde(default)]
    pub hosts: Vec<KnownHost>,
    #[serde(default)]
    pub dirs: Vec<String>,
}

/// Who the host says a token belongs to.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCheck {
    pub ok: bool,
    pub login: Option<String>,
    /// The granted scopes when the host reports them (GitHub's `X-OAuth-Scopes`).
    pub scopes: Option<Vec<String>>,
    pub message: Option<String>,
}

/// The `forge://auth-changed` payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthChanged {
    pub provider: ProviderKind,
    pub host: String,
}

/// A repo on a code host, as the providers address it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub provider: ProviderKind,
    /// The host name, plus `:port` when an https remote named a non-default port.
    pub host: String,
    /// GitHub `[owner, repo]`; Bitbucket `[workspace, slug]`; GitLab the full group path;
    /// Azure DevOps `[org, project, repo]`.
    pub path: Vec<String>,
    pub web_url: String,
}

#[derive(Clone)]
pub struct Token {
    pub value: String,
    pub source: TokenSource,
    pub expires: Option<Instant>,
}

impl Token {
    pub fn is_expired(&self) -> bool {
        self.expires.is_some_and(|e| Instant::now() >= e)
    }
}

// Hand-written so a `{:?}` anywhere can never print the secret.
impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Token")
            .field("value", &"<redacted>")
            .field("source", &self.source)
            .field("expires", &self.expires)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).unwrap()
    }

    #[test]
    fn enums_serialize_as_contract_strings() {
        assert_eq!(s(&ProviderKind::AzureDevOps), "\"azureDevOps\"");
        assert_eq!(s(&ProviderKind::Github), "\"github\"");
        assert_eq!(s(&ReviewState::ChangesRequested), "\"changesRequested\"");
        assert_eq!(s(&AccountSource::CliActive), "\"cliActive\"");
        assert_eq!(s(&AccountSource::None), "\"none\"");
        assert_eq!(s(&ForgeErrorKind::NotARepo), "\"notARepo\"");
        assert_eq!(s(&ForgeErrorKind::SsoRequired), "\"ssoRequired\"");
        assert_eq!(s(&RunStatus::Cancelled), "\"cancelled\"");
    }

    #[test]
    fn structs_serialize_camel_case() {
        let e = ForgeError::new(ForgeErrorKind::RateLimited, "slow down");
        let v = serde_json::to_value(&e).unwrap();
        assert!(v.get("retryAfterSecs").is_some());
        assert!(v.get("signIn").is_some());
        assert!(v.get("azCli").is_none());
        let e = ForgeError {
            az_cli: Some(false),
            ..e
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v.get("azCli"), Some(&serde_json::Value::Bool(false)));
    }

    #[test]
    fn token_debug_hides_the_value() {
        let t = Token {
            value: "fake-secret-value".into(),
            source: TokenSource::CredentialManager { target: "t".into() },
            expires: None,
        };
        assert!(!format!("{t:?}").contains("fake-secret-value"));
    }
}
