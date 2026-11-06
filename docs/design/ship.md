# Ship

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.20 Ship (`src-tauri/src/forge/`)

The Ship pane (4.20) shows a repo's CI runs and open pull requests, and an Overview of every
pinned repo. The core talks to the code host's REST API, and every host returns the same normalized shapes (section 7), so the front end
knows a host only through a few capability flags. The module is split by concern: `mod.rs` (the
commands, repo resolution, and the `ForgeProvider` trait), `types.rs` (the shapes), `remote.rs`
(remote URLs), `auth.rs` (token sources and accounts), `accounts.rs` (the Accounts tab's commands,
below), `http.rs` (the client), and one file per provider: `github.rs`, `bitbucket.rs`,
`gitlab.rs`, and `azure_devops.rs`. The Windows Credential Manager access sits in
`src-tauri/src/credential_store.rs`, outside the module, because `bb.exe` compiles it too.

- **Provider trait.** `ForgeProvider` has `kind`, `capabilities`, and the blocking methods `runs`,
  `jobs`, `log`, `rerun`, `cancel`, `pulls`, `pull_checks`, and `default_branch`, each taking a
  `Cx` (the shared `Http` and the resolved `Token`) and a `RepoRef`. The commands already run on
  `spawn_blocking`, so the methods are blocking, which keeps the trait object safe with no async
  trait crate. `provider(kind)` returns the provider for each of the four kinds. `RepoRef`
  carries the provider, host, a path (GitHub `[owner, repo]`, Bitbucket `[workspace, slug]`,
  GitLab the full group path, Azure DevOps `[org, project, repo]`), and the repo's web URL.
- **Commands.** All are async, run their work on a blocking thread, and return a `ForgeError` on
  failure: `forge_repo(root)`, `forge_runs(root, branch)` (newest first, at most 20; a null branch
  means every branch), `forge_jobs(root, runId)`, `forge_log(root, runId, jobId)`,
  `forge_rerun(root, runId, failedOnly)`, `forge_cancel(root, runId)`,
  `forge_pulls(root, openOnly, branch)` (at most 50, with the host's count of all that match),
  `forge_pull_checks(root, pulls)` (below), `forge_overview_repo(target)` (below), and
  `forge_set_account(root, user)`. `root` is the pane's folder; a folder that is not a
  directory or not inside a repo is `notARepo`.
- **Remote targets.** Every command takes a target key: a local folder, or `remote:<host>/<path>`
  for a repo with no clone, such as one pinned by typing its address. `parse_repo_input` reads the
  `<host>/<path>` form, an https, ssh, or scp remote URL, and a web URL into the repo (a pull
  request, a pipeline, a file), dropping the trailing page. A remote target has no current branch
  and no repo config, so its account is the one a fresh clone would get (the host's only or active
  GitHub CLI account; the other hosts have none), and `git credential fill` runs from the home
  folder, reading the helpers from global and system config. `forge_set_account` returns an error
  for it, since there is no repo config to store an account in. A target that does not parse is
  `unsupportedHost`, with a message that leaves the address out, as remote URLs are.
- **Overview.** `forge_overview_repo(target)` returns an `OverviewRepo` (section 7) in one call: the
  newest 20 runs on every branch, the open pull requests (at most 50), and the default branch,
  fetched in parallel after one token lookup. An error from the runs or the pull requests is the
  call's error; a failed default-branch lookup only leaves `defaultBranch` null.
- **Default branch.** `default_branch` is GitHub's `default_branch`, Bitbucket's
  `mainbranch.name`, GitLab's project `default_branch`, and Azure DevOps's repository
  `defaultBranch`; a provider that does not say returns null. The core caches it per provider,
  host, and path for an hour, and a failed lookup caches nothing.
- **Remote.** The remote is the current branch's upstream remote (`branch.<name>.remote`, ignoring
  `.`), else the one Publish uses (3.9): `origin`, else the only remote. A repo with no remote is
  `noRemote`. `parse_remote` reads `https://`, `ssh://`, and scp-form URLs, keeping an https
  remote's port (the web and API URLs use it too) and its `user@`, and dropping any password
  unread. Every Azure DevOps form (`dev.azure.com`, `ssh.dev.azure.com`, `vs-ssh.visualstudio.com`,
  and `<org>.visualstudio.com`) normalizes to host `dev.azure.com` and `[org, project, repo]`.
  A GitLab remote keeps its whole group path, nested groups included, and its port.
  `ssh.github.com` is `github.com`. Remote URLs never appear in messages, since an https remote
  can carry a password.
- **Host classification.** `classify` picks the provider from the `ship.hosts` setting (section
  8) first, then the well-known hosts (`github.com`, `bitbucket.org`, `gitlab.com`,
  `dev.azure.com`), then treats any host the GitHub CLI is signed in to (a top-level key in its
  `hosts.yml`) as GitHub Enterprise Server, then any host under `hosts:` in GitLab CLI's
  `config.yml` as self-managed GitLab (only the key names are read, never a token). Anything else
  is `unsupportedHost`. The Bitbucket
  provider speaks only Bitbucket Cloud (`api.bitbucket.org`): for another host it answers
  `unsupportedHost` with "Bitbucket Data Center isn't supported yet" before sending a request, so a
  self-hosted host's Git Credential Manager token never goes to Bitbucket Cloud. The Azure DevOps
  provider speaks only Azure DevOps Services (`dev.azure.com`). `ship.hosts` is therefore for
  GitHub Enterprise Server hosts the CLI is not signed in to, and for self-managed GitLab hosts
  that GitLab CLI's config does not list.
- **Tokens.** Bashboard never runs an OAuth flow, and the secrets it writes are a Bitbucket API
  token and Azure DevOps personal access tokens (PATs), one per organization, into Windows
  Credential Manager (below). Each provider
  lists sources in order, and the first that yields a token wins. GitHub: `gh auth token
  --hostname <host>` (with `--user <account>` when an account is chosen), found on `PATH` or in
  GitHub CLI's install folders, since a `gh` installed while Bashboard runs is not on the `PATH` it
  inherited; then `git credential fill`, which reaches Git Credential Manager. Bitbucket: the
  generic Windows credential `bashboard:bitbucket.org`, which the Accounts tab and `bb auth
  bitbucket` write (3.13); then Git Credential Manager as a fallback. GitLab: `glab auth status
  --hostname <host> --show-token` (glab has no `auth token` command), read from its labeled token
  line, with a masked value counting as none, found on `PATH` or in glab's install folders and
  kept for only 10 minutes, since glab refreshes its OAuth tokens itself; then Git Credential
  Manager for the host. Azure DevOps: the PAT stored for the repo's organization, the generic
  credential `bashboard:dev.azure.com/<org>` (the organization lowercased, since organization
  names are case-insensitive); then the `AZURE_DEVOPS_EXT_PAT` environment variable (trimmed, an
  empty value counting as unset), which the app reads from its own process environment, so a
  variable set only in another tool's configuration does not reach it; then an Entra token from
  `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` (Azure CLI found on
  `PATH` or in its install folders, the token cached until 5 minutes before it expires); then Git
  Credential Manager, asked with the organization as the credential's `path`, since it keeps one
  Azure DevOps credential per organization. A stored PAT is per organization because a PAT made
  for all accessible organizations (a global PAT) stops working on January 27, 2027. A stored PAT
  that Azure DevOps refuses is reported as rejected and is not passed over for the Azure CLI, so a
  stale PAT never hides behind another identity. `git credential fill` runs with `GCM_INTERACTIVE=never`
  and `GIT_TERMINAL_PROMPT=0`, so it never opens a sign-in window, passes the account as the
  `username` when one is chosen, and its reported expiry is honored. Bashboard never calls
  `approve` or `reject`, since the credential belongs to the user's helper. Tokens are cached in
  memory by provider, host, and account (for Azure DevOps, the organization takes the account's
  place in the key). A call that answers 401 drops its cached token, resolves
  one fresh, and retries once before the error stands.
- **Auth header.** GitHub, Bitbucket, and GitLab send the token as `Bearer`. Azure DevOps takes
  a PAT only as `Basic` (an empty user name, then the token) and an Entra token only as `Bearer`,
  so the header follows the source: a stored PAT and an environment PAT are `Basic`, an Azure CLI
  token is `Bearer`, and a Git Credential Manager password is `Bearer` when it has the shape of a
  JWT (three base64url parts, the first starting `eyJ`, which is what Git Credential Manager
  returns when `credential.azreposCredentialType` is `oauth`) and `Basic` otherwise.
- **Accounts.** GitHub is the only host with several signed-in accounts. They come from GitHub
  CLI's `hosts.yml` (the host's `users` names and its active `user`); only those keys are read,
  never an `oauth_token`. GitLab CLI and Azure CLI hold at most one: the user from glab's "Logged
  in to <host> as <user>" status line (the token line is never read) or from `az account show
  --query user.name`. The account a repo uses is, in order: `credential.username` from the
  repo's git config (local, or `credential.<url>.username` for `https://<host>/`), the `user@` of
  an https remote, the host's only account, or the CLI's active account when there are several.
  `ForgeRepo.accountSource` names which (`repoConfig`, `remoteUrl`, `only`, `cliActive`, or
  `none`). `forge_set_account` refuses a user not among the host's accounts, runs `git config
  --local credential.username <user>`, drops that root's repo and token caches, and returns the
  re-resolved repo. That setting is the one that also stops Git Credential Manager asking which
  account to use on every push.
- **Accounts commands** (`forge/accounts.rs`) serve the Accounts tab (4.20), and none returns a
  token. `forge_auth_status(known)` returns one `HostAuth` per card, each with a signal saying the
  host is used on this machine (`detected`, with `detectedBy` holding the reasons in words) or not.
  `github.com`, `gitlab.com`, `bitbucket.org`, and `dev.azure.com` are always listed. Any other host
  is listed once something detects it: a host in GitHub CLI's `hosts.yml`, a host in GitLab CLI's
  config, a `ship.hosts` entry mapped to `github` or `gitlab` (a CLI host that `ship.hosts` maps to
  another provider is left out, since the pane would not treat it as that CLI's), or a host in
  `known`. `known` is what the front end alone knows: `{ hosts, dirs }`, the provider and host of
  every pin and open Ship pane, and the folders of open terminal panes, whose repo host comes from
  the `origin` remote (else the first). A stored Bitbucket token, a stored Azure DevOps PAT, a
  non-empty `AZURE_DEVOPS_EXT_PAT`, and an installed Azure CLI detect the Bitbucket and Azure DevOps
  cards. Bitbucket Cloud and Azure DevOps Services are one card each, so every host of theirs (the
  `<org>.visualstudio.com` forms included) counts toward `bitbucket.org` and `dev.azure.com`. The
  order is GitHub (`github.com` first, the other GitHub hosts alphabetically), GitLab hosts
  alphabetically, `bitbucket.org`, then `dev.azure.com`; the front end splits detected cards from
  the rest without reordering them. A `HostAuth` carries `cliInstalled` (`gh`, `glab`, or `az`
  found on the `PATH` or in its install folders; false for Bitbucket), the CLI's `accounts` and
  `activeAccount`, the kind of source the Ship pane would take its token from (`TokenSourceKind`:
  `ghCli`, `glabCli`, `azCli`, `gitCredentialManager`, `bashboardCredential`, or `environment`;
  null when none yields one), and `storedTokens`, the tokens Bashboard stored for the host: at most
  one for Bitbucket, and one per organization for Azure DevOps, found by listing the credentials
  under `bashboard:dev.azure.com/`. An Azure DevOps card with a stored PAT reports
  `bashboardCredential`, since a stored PAT wins for its organization and the card has no one
  organization to resolve for. Hosts are inspected side by side, and only the source's kind leaves
  the lookup. `ghEnvToken` is the name of the environment variable that `gh` in a terminal would use
  for the host instead of its saved accounts, or null (always null off GitHub, and for a GitHub
  host with none set); only the name leaves the core, never the value. The app's own lookup passes
  `--user`, so it reads the saved account whatever the variable says. GitHub CLI's rules: for `github.com` and `*.ghe.com` hosts, `GH_TOKEN` then
  `GITHUB_TOKEN`; for other hosts, `GH_ENTERPRISE_TOKEN` then `GITHUB_ENTERPRISE_TOKEN`. An empty
  value counts as unset. `forge_auth_test(provider, host, account, org)` resolves that token and asks the host who
  it belongs to, bypassing the ETag cache: GitHub `GET /user`, reading the login and the
  `X-OAuth-Scopes` header (sent only for classic tokens and OAuth apps), Bitbucket `GET
  /2.0/user`, GitLab `GET /api/v4/user` (the username), and Azure DevOps `GET
  /<org>/_apis/connectionData` (the signed-in display name), using the sources of that
  organization, which `org` names; with no `org` it answers `ok: false`, asking for an Azure DevOps repo
  to be opened first, and a reply that names nobody fails the test. It returns an `AuthCheck` (`ok`, `login`, `scopes`, `message`), and an error comes
  back as `ok: false` with its message, so a Bitbucket 403 names the missing scope.
  `forge_set_token(provider, org, token)` stores a token in Windows Credential Manager and
  `forge_clear_token(provider, org)` deletes it (false when none was stored). Bitbucket's is the
  credential `bashboard:bitbucket.org` with the user name `x-bitbucket-api-token-auth`, and ignores
  `org`; an Azure DevOps organization's is `bashboard:dev.azure.com/<org>` with the user name
  `x-azure-devops-pat`, and `org` is required: it is trimmed and lowercased, and an empty name, or
  one holding a slash, whitespace, or a control character, is refused. Any other provider is
  refused. `forge_gh_switch(host, user)` and
  `forge_gh_logout(host, user)` run `gh auth switch` and `gh auth logout` with `--hostname` and
  `--user`; they refuse a user who is not among that host's `hosts.yml` accounts, run with a hidden
  console, `GH_PROMPT_DISABLED=1`, and no standard input, so `gh` never prompts, and report its
  standard error on failure. Both remove `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and
  `GITHUB_ENTERPRISE_TOKEN` from `gh`'s environment, since `gh` refuses to switch or log out while
  one applies to the host. `forge_glab_logout(host)` runs `glab auth logout --hostname <host>` the
  same way; glab holds one account per host, so it names none. Every successful change drops the host's cached tokens and resolved
  repos and emits `forge://auth-changed` with `{ provider, host }`; Ship panes (`ShipStore`),
  the Overview store, and an open Accounts tab refresh on it. A sign-in finished in a terminal
  pane changes `hosts.yml` without passing through the core, so the tab also reloads when it is
  shown and when the window regains focus.
- **Token handling.** A Bitbucket token or an Azure DevOps PAT enters the core only from the
  Accounts tab's password field, as an argument of `forge_set_token`, or from `bb auth` in a
  separate process. It is never sent from the core to the page, never logged, never put in an
  error message, and never written anywhere but Windows Credential Manager. The core overwrites
  its copies after the write; that is best effort, since the buffers the IPC layer fills while
  deserializing the argument are outside the app's control, so the app does not claim the token is
  wiped from memory.
- **Errors.** Providers and the HTTP layer return `ForgeError { kind, message, url, signIn,
  retryAfterSecs }`. `message` is plain text and never holds a token or a header; the HTTP layer
  builds messages from status codes and host names only. A 401 is `signedOut`, and so is a 2xx
  reply to a JSON request that is an HTML page (Azure DevOps answers a refused or wrong-organization
  token with its sign-in page, often a 203; a log fetch decides on the content type alone, since a
  log may begin with `<`); a 403 with GitHub's
  `X-GitHub-SSO` header is `ssoRequired`, carrying the authorize URL; a 429, or a 403 with
  `Retry-After` or an exhausted `X-RateLimit-Remaining`, is `rateLimited` with the seconds to wait;
  any other 403 is `forbidden`, and a 404 is `notFound`. A Bitbucket 403 body names the scopes the
  token lacks (`error.detail.required`), and the message is "This token is missing the X
  scope." in place of the generic "The code host refused access to this repo." Only scope-shaped
  strings are echoed. A `forbidden` result drops the cached token for that provider, host, and
  account and resolves it again; the call repeats once only when the resolved token's value differs
  from the one that failed (compared in memory), so a token stored after a missing-scope 403 takes
  effect without a restart, while an ordinary 403 costs no extra request and a mutating call
  (re-run, cancel) never repeats with the same token. `signedOut` is finished in `mod.rs` into the next
  step. For GitHub with `gh` installed, `signIn` is `gh auth login --hostname <host> --web`; with
  `gh` missing, the kind becomes `notInstalled`, `url` is cli.github.com, and `signIn` is `winget
  install --id GitHub.cli -e`. For GitLab the same split applies with `glab`: `signIn` is `glab
  auth login --hostname <host>`, or, with `glab` missing, the kind becomes `notInstalled`, `url` is
  GitLab CLI's page, and `signIn` is `winget install --id GLab.GLab -e`. For Bitbucket the message says whether no token is stored or the
  stored token was rejected (it may have expired or lack a scope), `url` is the Atlassian token
  page, and `signIn` is `bb auth bitbucket`, and the message names the Accounts tab first. For
  Azure DevOps, `signedOut` and `forbidden` both carry the organization's token page
  (`https://dev.azure.com/<org>/_usersSettings/tokens`) as `url` and `bb auth azure-devops <org>`
  as `signIn`, and a `signedOut` message says which source failed: none was found (add a PAT in
  the Accounts tab, or run `bb auth azure-devops <org>`); the stored token was rejected (expired,
  revoked, or made for another organization); the `AZURE_DEVOPS_EXT_PAT` token was rejected; Azure
  CLI's sign-in was refused, with the hint to run `az login --tenant <tenant>`, since a wrong tenant
  answers like no access at all; or Git Credential Manager's sign-in was refused. A message that
  says "rejected" is what the notice keys on to lead with Replace token. A GitHub `notFound` on a host with several accounts
  points at the account menu. A Git Credential Manager token that Bitbucket refuses gets a message
  saying that its sign-in cannot read pipelines or pull requests.
- **HTTP.** One `ureq` agent with a 15 second timeout, the system proxy, and the Windows
  certificate store as its roots, so a corporate TLS inspection root is trusted. Redirects are
  followed by hand. A request follows one redirect to the same host with the same credentials
  (GitHub answers a renamed repo's API URL with a 301); a job log's redirect, which leads to
  another host's signed URL, is followed without the `Authorization` header or any header the
  caller set. GETs go through an ETag cache of 256 entries, least recently used out, keyed by
  method, URL, and a hash of the token, so a 304 reuses the cached body. A log is read to its end
  and only the last 1 MiB is kept, cut after a newline, with `truncated` set.
- **GitHub.** github.com uses `api.github.com`; an Enterprise Server host uses
  `https://<host>/api/v3` and `/api/graphql`. Runs, jobs, logs, re-run, re-run failed jobs, and
  cancel use the REST Actions API. Open pull requests come from one GraphQL query, since REST would
  need a request per pull request for reviews and checks, and its `totalCount` is the open count;
  a GraphQL failure arrives as HTTP 200
  with an `errors` array, which is mapped to the same error kinds. A run's status comes from its
  `status`, or its `conclusion` once completed: `action_required` is `waiting`; `queued`,
  `requested`, `pending`, and `waiting` are `queued`; `failure`, `timed_out`, and `startup_failure`
  are `failure`. A run's finish time is its last update, since it has no completion time of its
  own. A pull request's reviewers are its requested users (pending, even when they reviewed
  before) and the authors of the latest reviews. Team review requests are not listed. A pull
  request whose author was deleted shows as "ghost".
- **Bitbucket.** `api.bitbucket.org/2.0` with a Bearer token. A pipeline is a run, and its steps
  are its jobs, with no per-command step list, so `steps` is empty. A pipeline's `PAUSED` and
  `HALTED` states are `waiting`, and `STOPPED` is `cancelled`. Re-run starts a new pipeline on the
  same target (branch or pull request, selector, and commit); custom pipeline variables are not
  kept. There is no failed-only re-run (`rerunFailed` is false), and cancel is `stopPipeline`. A
  step that has not started has an empty log. Pull requests are listed with a `fields` selection of
  only what the row shows, including participants, and the page's `size` is the matching count; the viewer's uuid comes from `/user` once per token and marks the
  pull requests that are yours or await your review. `read:user:bitbucket` is a required scope: a
  token without it fails the list with a `forbidden` error naming the missing scope. A pull request's checks are the worst of its commit's build statuses, fetched once per
  pull request and kept until its `updated_on` changes, which keeps polling inside Bitbucket's
  limit of 1,000 requests an hour per user. Merged and declined pull requests show no checks. The
  list returns at once with the cached rollups and marks the open ones still missing `checksPending`; the front end then asks `forge_pull_checks` for those, which
  fetches them eight at a time, and merges the answers into the rows. The pipelines list carries a commit's hash but not its
  message, so a pipeline titled by neither a commit message nor a pull request takes its commit's
  first line from `/commit/{hash}`, fetched once per hash for the session.
- **GitLab.** `https://<host>/api/v4`, where the host keeps the port of an https remote, with a
  Bearer token. A project is addressed by its full path, nested groups included, percent-encoded
  as one segment (`group%2Fsub%2Frepo`). A pipeline is a run, and a job is a job with no step
  list, so `steps` is empty; the API lists jobs newest first and the pane shows them oldest first.
  A job's log is its `trace`, and one that has not started has an empty log. The pipeline list
  lacks the name, the user, and the times, so each pipeline's detail is fetched, eight at a
  time, and cached until the list's `updated_at` for it changes; the title is the commit's first
  line from `/repository/commits/{sha}`, fetched once per commit. A pipeline's `created`,
  `waiting_for_resource`, `preparing`, `pending`, and `scheduled` are `queued`; `running` and
  `canceling` are `running`; `manual` is `waiting`; `failed` is `failure`; `canceled` is
  `cancelled`. Re-run is `POST /pipelines/{id}/retry`, which retries the failed jobs only, so
  `rerun` and `rerunFailed` are both true and do the same; cancel is `POST /pipelines/{id}/cancel`.
  Merge requests come from `/merge_requests` (`state=opened`, or `all`; newest update first; 50;
  `source_branch` for the branch filter), and the total is the `X-Total` header, which GitLab
  leaves out past 10,000 (then null), so the call is not served from the ETag cache. A `merged`
  request is merged, `closed` and `locked` are closed, and `draft` is the draft flag. GitLab has
  no "changes requested": a reviewer who approved is approved, every other reviewer is pending,
  and anyone else who approved is added as approved. The list carries neither the head pipeline
  nor the approvals, so its open rows come back `checksPending`, and `forge_pull_checks` fetches
  each merge request and its approvals (eight at a time), cached until the merge request's
  `updated_at` changes and asked again while its pipeline is still queued or running. The
  approvals and the head pipeline therefore show one poll after the list. The viewer's user id
  comes from `/user` once per host and token, and marks the merge requests that are yours or
  await your review.
- **Azure DevOps.** `https://dev.azure.com/{org}`, the path `[org, project, repo]` percent-encoded
  per segment, with `api-version=7.1` on every call except `7.1-preview` for `connectionData` and
  policy evaluations, which answer a plain `7.1` with a 400. Every call sends `X-TFS-FedAuthRedirect:
  Suppress`, since a refused token otherwise gets a 302 to a sign-in page on another host rather
  than a 401. The repo's id, its project's id, and its default branch come from one repository
  request, cached on success. A run is a build (`_apis/build/builds` for the repo's id, the newest
  20, filtered by `refs/heads/<branch>`); a pull request build is attributed to the pull request's
  source branch, and its title is the commit message's first line, else the pull request's title,
  else the build number. A build's `notStarted` and `postponed` are `queued`; `inProgress` and
  `cancelling` are `running`; once `completed`, its result decides: `succeeded` is `success`,
  `failed` and `partiallySucceeded` are `failure`, and `canceled` is `cancelled`. A build held at a
  stage approval stays `inProgress` (for weeks, if no one answers it), so each `inProgress` build's
  timeline is read too: an `inProgress` Checkpoint.Approval record with no Job record in progress
  makes the build `waiting`, and a pending job in the stage that approval gates is `waiting` as
  well. A failed timeline read leaves the build `running`. Jobs come from the build's timeline,
  which is flat and unordered: each Job record is a job, named `<stage> / <job>` when it is in a
  named stage, ordered by the `order` of its ancestors from the stage down, with its Task records
  as steps. A log is addressed by the record's log id, which exists only once the job has started
  (before that the log is empty). Re-run re-runs only the failed stages of the same build
  (`PATCH builds/{id}?retry=true`), so `rerun` is false and `rerunFailed` is true, and a full
  re-run is refused. Cancel is `PATCH` with `{"status": "cancelling"}`. A 403 on either says the
  token is missing the Build (Read & execute) scope. Pull requests come from `searchCriteria.status`
  `active`, or `all` (the newest 50, `searchCriteria.sourceRefName` for the branch filter); `isDraft`
  is the draft flag, `completed` is merged, and `abandoned` is closed. A reviewer's vote of 10 or 5
  is approved, -5 or -10 is changes requested, and 0 is pending; a reviewer who declined is not
  listed. The decision is changes requested when any reviewer asked, else approved when any
  approved. The list carries no checks, so its open rows come back `checksPending` unless a settled
  rollup is cached for the same source commit; `forge_pull_checks` fetches policy evaluations one
  pull request at a time, since Azure DevOps throttles by load per user, and the rollup is the
  worst of the enabled Build validation and external Status check evaluations, skipping
  `notApplicable` ones (`rejected` or `broken` is `failure`, then `running`, then `queued`, and
  all `approved` is `success`). A queued or running rollup is asked again on the next poll. The
  viewer's identity id comes from `connectionData` once per token and organization, and marks the
  pull requests that are yours or await your vote. The list has no updated time, so a pull request's
  `updatedAt` is its closing time or else its creation time, and its total is the page's size when
  the page is not full, else null.
- **Capabilities.** GitHub: re-run, re-run failed, cancel, logs, drafts, accounts; nouns "pull
  request" and "workflow run"; minimum poll 10 s. Bitbucket: re-run, cancel, logs, drafts, no
  failed-only re-run, no accounts; nouns "pull request" and "pipeline"; minimum poll 30 s. GitLab:
  re-run, re-run failed, cancel, logs, drafts, no accounts; nouns "merge request" and "pipeline";
  minimum poll 10 s. Azure DevOps: re-run failed (and no plain re-run), cancel, logs, drafts, no
  accounts; nouns "pull request" and "build"; minimum poll 20 s. Neither GitLab nor Azure DevOps
  has an Overview request budget; Bitbucket's alone is described in 4.20.
- **Caching.** The resolved repo (remote, branch, and account) is cached per root for 15 s. Tokens
  are cached as above, and the ETag, viewer, and checks caches live as long as the app, as do
  GitLab's pipeline details and commit titles and Azure DevOps's repo ids; a cache that grows
  past 2,000 entries starts over. A change
  made through an Accounts command drops that host's cached tokens and resolved repos at once.

## 4.20 Ship pane

A Ship pane has two views. The **Overview** is the default: one row per pinned repo, across GitHub,
Bitbucket, GitLab, and Azure DevOps, showing its deploy branches' health and its open pull requests, ordered by what needs
attention. A repo's own view, reached by drilling into a row, shows its CI runs and pull requests
from the repo's code host (3.20) as two tabs, **Pipelines** and **Pull requests** (the second reads
"Merge requests" on a host whose `prNoun` says so), with an **Overview** crumb at the start of the
tab strip that goes back. The drilled view resolves the repo's root as the Git pane does (4.13); a
folder outside a repo shows a notice. Its title is the repo's name while drilled in (the folder's
name, or the repo's name for one with no clone) and "Ship" on the Overview. The pane saves its
target (`root`, absent on the Overview), its tab, whether This branch is checked on Pipelines
(`thisBranch`) and on Pull requests (`thisBranchPulls`), and whether Open is cleared
(`allPulls`), each default omitted (section 7), and layouts keep it. The last four mean nothing
on the Overview.

**Opening.** An open with no repo context shows the Overview: the palette's Open the Ship tab
(4.5), the dashboard Ship section's header button (4.6), and a Ship pane chosen from the kind
menu (4.11) for a pane with no folder. When a Ship pane already exists, these back it out of any
repo it was drilled into. An open for a repo drills in: Launch's Ship button and menu entry (4.6),
a kind-menu choice that keeps the pane's folder, and a row of the Overview or the dashboard's
Ship section. A row shows the first Ship pane already drilled into that repo, else the first
Ship pane in tab order, drilled into it, else a new Ship tab. A saved pane reopens where it was
left.

**Pins.** The Overview shows the repos in `ship.pinnedRepos` (section 8). A pin's `repo` is
`<host>/<path segments>`, such as `bitbucket.org/keysys/kweb`, and is its identity; `root`, when
set, is a local clone, which gives the repo its local account and an Open terminal here entry;
`branches` adds health branches. Every ship command is addressed by the pin's target, which is its
`root` when set and `remote:<repo>` otherwise (3.20). The drilled view has a **Pin to Overview**
toggle in its bar, a quiet text button like the Git pane's Fetch that reads **Unpin** while pinned, which records the repo's local clone, if
any, as the pin's `root`. Pinning and unpinning rewrite the setting in place through the app, so
the file's comments survive, and an edit made in the file applies on save.

**Overview.** The pane's own bar (This branch, Open, the account chip) is hidden on the Overview,
which has its own line, "Updated 2m ago" (or "Not updated yet"), an **Accounts** button that opens
the Accounts tab (below), and a **Refresh** button that polls every pin at once. The Overview also refreshes when the pane takes focus while its newest
poll is more than 30 s old. With no pins, a note says to pin a repo from its Ship view or add one
there. Each row holds:

- A provider badge (GH for GitHub, BB for Bitbucket, GL for GitLab, AZ for Azure DevOps), the repo's `owner/name` (the full
  `<host>/<path>` in its tooltip), with the health branches under it, and beside them a pull
  request summary: "3 PRs open, 1 draft, 1 needs you, 1 approved", "1 PR open", or "No open pull
  requests" (with the host's noun, as initials when counted; the draft, needs-you, and approved
  parts appear only when nonzero, and approved counts only the viewer's own pull requests that wait
  only on a merge, as the dashboard's approved rows do, 4.6), highlighted in the warning color
  while a review is awaited, else in the success color while one of the viewer's is approved,
  with each approved one and its approvers in its tooltip ("#12 approved by Andrew Cartwright"). Under the summary,
  "2 pipelines running" counts the queued or running runs among the latest 20 on any branch, and
  is absent when none is.
- The **health branches**: the repo's default branch (3.20), then the distinct target branches of
  its open pull requests (a deploy branch is usually one), then the pin's own `branches`. Each shows
  the status icon of its newest run among the repo's latest 20 and the age of that run, with the
  status and the run's title in its tooltip; a branch with none among them reads "No recent run".
- A line with the error's title when the last poll failed, beside the last good data, and a button
  for each sign-in or install command, which runs in a terminal split (see Terminal splits below),
  and for each Accounts action (**Manage accounts**, **Add token**, **Replace token**), which opens
  the Accounts tab on that host.
  Before its first poll lands a row reads "Loading".

**Attention order.** Rows are ordered by the first of these that applies to a repo: a health branch
whose newest run failed; a pull request awaiting the viewer's review; the viewer's own pull request
with changes requested or failing checks, or approved and waiting only on a merge; a health branch with a queued or running run; then by
most recent activity (the newest run or pull request update). The first four ranks keep pin order
among themselves. A pin that has not loaded follows the loaded rows, in pin order. Ages redraw every
30 s while the Overview is on screen.

**Row actions.** Clicking a row drills into its Pipelines; its pull request summary drills into
its Pull requests, and its running count into its Pipelines. The row menu holds **Open Pipelines**, **Open Pull requests**, **Open in
browser** and **Copy link** (both disabled until the repo has resolved), **Open terminal here**
(only for a pin with a `root`), and **Unpin from Overview**. The rows share columns (a subgrid):
the repo and its health branches, then the pull request summary and running count, each as wide as its widest row
and both at the left, then at the right edge the buttons **Pipelines**, **Pull requests**,
**Open**, **Terminal**, and **Copy link**, matching the menu's entries without Unpin. Open and Copy
link are disabled until the repo resolves, and a pin without a `root` keeps an invisible Terminal
in its place, so the buttons line up down the list. Below 560 px of pane width the buttons are
hidden; the menu still holds every action. A drilled view with no clone has no
checked-out branch, so its This branch checkbox is disabled, and its account chip is hidden, since
the account is the host's default one.

**Add repo.** A box on the Overview, with a **Pin to Overview** button and Enter. With no repo
pinned it shows under the empty note; with pins it is hidden behind an **Add** chip in the bar,
left of Accounts, which toggles it open under the bar, and Escape in it closes it. It stays open
after a pin, including the first one made from the empty Overview, so several can be pinned in a
row. It
has a **?** button whose tooltip, also shown under the box on click, explains the forms with
examples, and takes a repo as `owner/name`, `host/owner/name`, or a link: an https, ssh, or scp remote URL, or a
web URL into the repo. A bare `owner/name` is taken as github.com, or as bitbucket.org when every
pin is on Bitbucket. The box resolves the address through `forge_repo` (3.20) and pins the
resolved identity, never the typed text, which can carry credentials or a page suffix; a failure,
or a repo already pinned, shows in place under the box. Below it, suggestions list the folders in
`repos.json` and the favorites that resolve to a supported host's repo, four resolved at a time,
one per repo and not already pinned, filtered by the typed text; clicking one pins the repo with
that folder as its `root`.

**Overview polling.** One shared store (`ShipOverviewStore`, `src/shipOverviewStore.ts`) holds
every pin's data for the Overview and for the dashboard's Ship section (4.6). It polls only
while some consumer wants it, which is an Overview on screen or the dashboard's Ship section
shown and expanded, and while the window is visible. Each pin polls `forge_overview_repo` (3.20)
on its own clock: every `ship.overviewRefreshMinutes` (the heartbeat), or every 60 s while any
of its latest 20 runs is queued or running, so the running count clears promptly. A pin's first poll waits a stagger of up to 500 ms
per pin, within 3 s, so a round of pins does not hit a host at once. When the window or a consumer
returns, only the pins that fell due poll. A rate-limited answer delays that pin by the seconds the
host asked for, or 60 s when it did not say; any other failure waits out the usual interval. A
heartbeat of 0 stops the interval polling, leaving Refresh and the 60 s polling of a repo
with a run in progress. A refresh costs about 3 requests per repo (the runs, the open pull requests, and the checks
of pull requests that changed). Bitbucket allows 1,000 requests an hour per user, shared with
drilled Ship panes and any other tool on the same token, so Bitbucket pins share a budget of 600
Overview requests an hour: each one's interval, the heartbeat and the 60 s running poll alike, is
stretched to at least the pin count times 18 s, which leaves up to three pins at the usual pace and
holds ten to every 3 minutes. Other hosts are not budgeted. While the budget slows Bitbucket below
the 60 s running poll, the bar notes the gap beside the Updated line ("Bitbucket every 3 min").
Pinning or unpinning a Bitbucket repo retimes the others' next poll. Changing a pin's target or
branches takes effect without waiting for the next poll.

**Store.** `ShipStore` (`src/shipStore.ts`) holds one drilled repo's repo info, runs, and pull
requests, shared by every Ship pane on that root and reference counted, so two panes on a repo
make one set of requests. A pane wants its store only while expanded.

**Bar.** On a drilled repo, from the left: the **Overview** crumb and the two tabs; a **This branch** checkbox, clear by default and
shown on both tabs, labeled "This branch (<branch>)" once the branch is known and truncated with
an ellipsis when long; an **Open** checkbox, checked by default and shown on the Pull requests
tab only; the repo's `owner/name`, linking to its `webUrl`, once the repo has
resolved; the account chip; the pin toggle; **Accounts**, which opens the Accounts tab (below) on the repo's
host; and **Refresh**, which polls at once. Each tab keeps its own This branch choice: on
Pipelines it limits the list to runs on the branch, and on Pull requests to pull requests whose
source branch it is, filtered by the host (GitHub's `headRefName`, Bitbucket's
`q=source.branch.name="<branch>"`, GitLab's `source_branch`, Azure DevOps's
`searchCriteria.sourceRefName`) so the 50-item cap never hides one. Each choice is shared by
the panes on one repo: a pane that opens on a repo another pane already shows takes that pane's
choices, and the first pane to open a repo applies its own saved ones. Open is shared the same
way. This branch follows the repo's current local branch, resolved again on every run poll, so a
checkout empties a scoped list and loads the new branch's; a detached HEAD has no branch and
lists every branch. The chip reads
"as @name" and appears only when the host holds several accounts (`capabilities.accounts` and
more than one in `accounts`). It is styled as a warning when the account came from
`cliActive`, since the repo then follows whichever account `gh auth switch` last chose, and
its tooltip says so. Clicking it opens the account menu: one radio entry per signed-in account, a
disabled note that picking sets the repo's `credential.username`, which Git Credential Manager
also uses for push and pull, **Sign in another account**, which runs `gh auth login
--hostname <host> --web` in a terminal split, and a final **Manage accounts**, which opens the
Accounts tab on the repo's host. Picking an account calls `forge_set_account`,
replaces the store's repo, and reloads everything.

**Pipelines.** Each run is a row: a status icon, the run's title (the commit's first line, or the
host's display title), a line beneath it with the workflow or pipeline name when it differs from
the title, `#<number>`, the branch, and the actor, and on the right the age ("5m ago") and the
duration, which runs live for a running run. Ages and durations redraw every second while the
pane is expanded and the window is visible. The status label (tooltip) is Queued, Running,
Waiting for approval, Passed, Failed, Cancelled, Skipped, or Unknown. Clicking a row expands its
jobs. The list is the latest 20 runs, and an empty list says so.

- **Jobs.** Each job shows its status, name, and duration, then its steps when the host reports
  them (GitHub does, and an Azure DevOps job's steps are its tasks; a Bitbucket step carries no
  per-command list and a GitLab job has no steps), with a failed step marked. GitHub's jobs are
  its workflow jobs, Bitbucket's are the pipeline's steps, GitLab's are the pipeline's jobs, and
  Azure DevOps's are the build's timeline jobs, each named with its stage when it has one.
  **Show log** loads
  the job's log on demand: ANSI escapes, GitHub's per-line timestamps, a byte order mark, and
  carriage returns are removed, a log cut to its last 1 MiB says so, and the view starts scrolled
  to the end, where the failure is. An expanded run's jobs reload when a poll changes its status or
  while it is still moving, and a job's open log is kept across reloads.
- **Run buttons.** At each row's right edge: **Open** (in the browser), **Re-run**, **Re-run
  failed**, **Cancel**, and **Copy link**, enabled as the menu's entries of the same names are, with Cancel
  disabled rather than absent on a run that is not live. Every row carries the same buttons, and
  one the host cannot do is hidden on every row alike, so they line up down the list. Clicking one
  acts without expanding the row. Below 420 px of pane width the buttons are hidden, leaving the
  title its room; the menu still holds every action. `runActionStates` in `src/shipMenus.ts`
  decides both the buttons and the menu.
- **Run menu.** Right-click a row: **Open in browser**; **Re-run** (greyed while the run is
  active); **Re-run failed jobs**, only on a host that has it (GitHub, GitLab, and Azure DevOps, where it
  re-runs the build's failed stages and is the only re-run offered), enabled for a failed run;
  **Cancel**, only for a queued or running run on a host that can; and **Copy link**. Cancel opens
  a confirmation naming the run and its branch, whose button reads "Cancel <run noun>" ("Cancel
  workflow run", "Cancel pipeline", "Cancel build"); Re-run and Re-run failed jobs do not ask. A re-run or cancel
  polls again after 3 s, and a failure of either shows as a toast, since the list stays as it was.
  Entries a host cannot do are left out rather than greyed.

**Pull requests.** The 50 most recently updated pull requests: open ones while **Open** is
checked, else those in every state (open, merged, and closed, with Bitbucket's declined and
superseded, GitLab's locked, and Azure DevOps's abandoned counted as closed), under group headers with counts: **Review
requested** (the viewer is a requested reviewer who has not reviewed; a request wins over
ownership), **Yours**, and **Others**; empty groups are left out. Within a group, open ones come
first, then open drafts, then merged and closed ones, each most recently updated first. A row
shows `#<number>`, the title, a Draft badge on an open draft or a Merged or Closed badge, with the
title dimmed, on one that is not open, the
author and source and target branches, the review state (Approved, Changes requested, or Review
pending; Approved names its approvers in its tooltip, and is the one state still shown when the
pane is narrower than 320 px), the checks status icon (a faint pulsing dot while it loads), and the age of the last update. Clicking a row opens the pull
request in the browser. The menu holds **Open in browser**, **Copy link**, and **Copy branch
name**. When the host counts more matching
pull requests than the 50 listed, a note after the groups reads "Showing the latest 50 of 60 open
pull requests.", leaving out "open" while Open is cleared (with "merge requests" on a host that
uses that noun); `src/shipModel.ts` builds the text. Changing Open empties the list and asks
again, dropping any reply to the other question still in flight.

**Polling.** Runs poll while any expanded pane is on the store: every 15 s while a run is queued
or running, else every 60 s, never faster than the host's `minPollSecs`. Pull requests poll only
while some expanded pane on the store is on the Pull requests tab, every `max(4 * minPollSecs, 60)`
s, since they change slowly and cost more on some hosts. Polling pauses while the window is hidden
or minimized and polls at once on return, as the Git pane's fetch does (4.13). A rate-limited
answer delays the next poll by the seconds the host asked for, and any other failure retries after
60 s; the notice's **Retry** and **Refresh** poll at once. When the window regains focus and the
pane's tab shows an error other than rate limiting, the pane polls again, so a sign-in or a new
token made outside the app takes effect without waiting out the retry. A reply to a question the
pane has since changed (another scope, branch, or account) is dropped.

**Toasts.** When a run that was queued or running in one poll is done in the next, a toast says so,
for example "Workflow run passed: CI on main", with an **Open** action that opens the run. A first
load announces nothing, and a run that moved to waiting has not finished. Panes sharing a store
receive the same finished runs and only the first announces them, so each finished run toasts once.

**Notices.** An error that stops a tab from showing anything replaces that tab's list with a setup
notice: what happened, and buttons that do the next step. An error from resolving the repo shows on
both tabs; one from polling runs or pull requests, only on its own tab. `src/shipModel.ts` builds
the notices from the error and the repo, and `ShipNotice` draws them. The buttons run a command in
a terminal split of this pane, open a URL, copy text (with a "Copied" toast), open the account
menu, open the Accounts tab, or retry.

**Terminal splits.** A command from a notice or the account menu (sign in, install) runs in a
terminal split off the pane, in the repo folder (the default starting folder when run from the
Overview, which has none), after focusing the Ship pane when it is expanded.
The terminal runs the command in place of a shell, as a container shell does (4.16), so a clean exit
closes it and a nonzero exit leaves it readable. Restore brings back one still open at quit as a
plain shell in that folder, since the command is not saved.

| Error | Notice and its buttons |
| --- | --- |
| `notInstalled`, GitHub | "Bashboard reads GitHub through the GitHub CLI." **Install with winget**, **Open cli.github.com**, **Manage accounts**, **Retry** |
| `notInstalled`, GitLab | "Bashboard reads GitLab through the GitLab CLI." **Install with winget** (`winget install --id GLab.GLab -e`), **Open the GitLab CLI page**, **Manage accounts**, **Retry** |
| `signedOut`, GitHub | "Sign in to `<host>` with the GitHub CLI." **Sign in** (`gh auth login --hostname <host> --web`), **Manage accounts**, **Retry** |
| `signedOut`, GitLab | "Sign in to `<host>` with the GitLab CLI." **Sign in** (`glab auth login --hostname <host>`), **Manage accounts**, **Retry** |
| `signedOut`, Bitbucket, no token | "Bitbucket needs an API token." The reason, the numbered steps, and the scope list, whose last step says to choose Add token here (or run `bb auth bitbucket` in a terminal); **Add token**, **Open the API token page**, **Copy scopes**, **Retry** |
| `signedOut`, Bitbucket, token refused | "Bitbucket rejected the stored API token." Steps and scopes folded under "How to make a new one"; the same buttons, with **Replace token** in place of Add token |
| `forbidden`, Bitbucket | "Bitbucket denied the request", with the message naming the missing scope; the same steps, scopes, and buttons as a refused token, so **Replace token** leads |
| `signedOut`, Azure DevOps, no token | "Azure DevOps needs a personal access token." The core's message naming the organization, the numbered steps and the scope list, whose last step says to choose Add token here (or run `bb auth azure-devops <org>` in a terminal); **Add token**, **Open the token page** (the organization's `_usersSettings/tokens` page), **Copy scopes**, **Sign in with Azure CLI** (`az login`), **Retry** |
| `signedOut`, Azure DevOps, token refused | "Azure DevOps rejected the token." The message names the source that failed; steps and scopes folded under "How to make a new one"; the same buttons, with **Replace token** in place of Add token |
| `forbidden`, Azure DevOps | "Azure DevOps denied the request", with the message; the same steps, scopes, and buttons as a refused token, so **Replace token** leads |
| `notFound`, GitHub, several accounts | "`<owner>/<name>` wasn't found as @`<account>`." **Use another account** (opens the account menu), **Retry** |
| `ssoRequired` | "Single sign-on needs authorizing", **Authorize** (the host's URL), **Retry** |
| `rateLimited` | "Rate limit reached", with when polling resumes |
| `unsupportedHost` | "`<host>` isn't supported", the message, and how the `ship.hosts` setting names a self-managed host's provider, with an example to copy; **Copy setting**, **Retry**. A message ending "isn't supported yet" (Bitbucket Data Center) shows with **Retry** only |
| `notARepo` | "Not a git repository" |
| `noRemote`, `network`, `other`, other `forbidden` and `notFound` | A titled notice holding the error's message, with **Retry** |

The Bitbucket scope list comes from `BITBUCKET_SCOPE_INFO` and is shown as a table in
[setup.md](../setup.md#bitbucket-cloud): `read:repository:bitbucket`, `read:pullrequest:bitbucket`,
`read:pipeline:bitbucket`, `write:pipeline:bitbucket` (optional, for re-run and stop), and
`read:user:bitbucket`. **Copy scopes** copies them space separated. The Azure DevOps scope list
comes from `AZURE_DEVOPS_SCOPE_INFO`, `Code (Read)` and `Build (Read & execute)`, shown in
[setup.md](../setup.md#azure-devops); its **Copy scopes** copies them comma separated.

**Accounts tab.** The app dialog's Accounts tab (4.18; `accountsTab.ts`, with `forgeHostCard.ts`,
`forgeTokenForm.ts`, and the pure `forgeAccountsModel.ts`) has one card per code host, from
`forge_auth_status` (3.20), which the tab asks with what it knows: the hosts of pins and open Ship
panes, and the folders of open terminal panes. The cards the core marks detected come first, in its
order: GitHub hosts (`github.com` first), GitLab hosts, `bitbucket.org`, then `dev.azure.com`. Every
other card folds under a **More hosts (N)** toggle, absent at zero, that reveals them dimmed, each
marked "Not detected on this machine". `github.com`, `gitlab.com`, `bitbucket.org`, and
`dev.azure.com` always have a card, so a host can be set up before it is used. A detected card's
tooltip lists why: GitHub CLI is signed in, GitLab CLI's config names it, the `ship.hosts` setting, a
pinned repo or open Ship pane, a terminal pane's repo, a stored API token or personal access
token, `AZURE_DEVOPS_EXT_PAT` is set, or Azure CLI is installed. A card shows
status and never a token. The tab loads when it is shown, when the window regains focus, and on
`forge://auth-changed`, so a sign-in finished in a terminal pane appears without a restart.

- **GitHub card.** Whether `gh` is installed; the signed-in accounts, the active one badged; and
  the status line for the active account's token source (GitHub CLI, Git Credential Manager, or
  none). A card whose only source is Git Credential Manager has no account rows and offers a
  card-level **Test**. Buttons: **Sign in** (**Sign in another account** once an account exists),
  which runs `gh auth login --hostname <host> --web` in a new terminal pane; **Install GitHub CLI**
  while `gh` is missing, which runs `winget install --id GitHub.cli -e` the same way. The dialog
  closes first, since it is modal and the sign-in device code would open hidden behind it. Each
  account row has **Make active** (not on the active one), which runs `gh auth switch` in the core;
  **Sign out**, which asks first ("Signs @name out of GitHub CLI on <host>. Other apps that use gh
  lose this account too.") and then runs `gh auth logout` in the core; and **Test**.
  When the host's `ghEnvToken` is set, a muted note under the status reads "<VAR> is set, so gh in
  a terminal uses that token; Bashboard uses the saved account shown here." Every action stays.
- **GitLab card.** One per GitLab host, titled "GitLab" for `gitlab.com` and "GitLab (<host>)" for a
  self-managed one. The status line is the user GitLab CLI is signed in as ("Signed in as @name
  through GitLab CLI"), else Git Credential Manager's sign-in, else "Not signed in", with ", and
  GitLab CLI is not installed" when `glab` is missing. Buttons: **Install GitLab CLI** while `glab`
  is missing, which runs `winget install --id GLab.GLab -e` in a new terminal pane; **Sign in**
  while it is installed and signed out, which runs `glab auth login --hostname <host>` the same
  way, closing the dialog first; **Sign out** once it is signed in, which asks first ("Signs @name
  out of GitLab CLI on <host>. Other apps that use glab lose this sign-in too.") and then runs
  `glab auth logout` in the core (`forge_glab_logout`); and a card-level **Test** whenever a user
  or any token source exists.
- **Bitbucket card.** Whether a `bashboard:bitbucket.org` token is stored, else the source the app
  would use; Git Credential Manager alone warns that it cannot read pipelines or pull requests.
  Buttons: **Add token** (**Replace token** and **Remove token** once one is stored), **Test**,
  **Open the API token page**, and **Copy scopes**, with the scope list and what each is for
  beneath. **Remove token** asks first, and the Bitbucket panes stop working until a token is
  added again. Add and Replace open the token form below the buttons.
- **Azure DevOps card.** One card for `dev.azure.com`, whatever the organization. The status line
  lists the organizations with a stored PAT ("Personal access token stored for <orgs>"), since a
  stored PAT outranks every other source for its organization; else the source the pane would use
  (the `AZURE_DEVOPS_EXT_PAT` variable, Azure CLI with the user it is signed in as, or Git
  Credential Manager); else "No personal access token stored", with ", and Azure CLI is not
  installed" when `az` is missing. Under it, one row per organization with a stored PAT, each
  with **Replace** (opens the token form with that organization filled in), **Remove** (asks
  first: "Deletes the personal access token Bashboard stored for the <org> organization. Its Ship
  panes fall back to the next token source, if there is one."), and **Test**. Buttons: **Add
  token**, **Sign in with Azure CLI** when `az` is installed (runs `az login` in a new terminal
  pane), a card-level **Test** when a PAT is stored or any source exists, **Open the token page**,
  and **Copy scopes**, with the scope list and what each is for beneath. **Open the token page**
  opens the organization's `_usersSettings/tokens` page for the form's organization, else the
  suggested one, else the first with a stored PAT; with none known it opens the form and asks for
  the organization.
- **Test.** Asks the host who the credential belongs to (3.20) and shows the login and, on GitHub,
  the granted scopes, or the error beside the card; a Bitbucket 403 names the missing scope. On
  GitHub it runs per account, so a signed-in account that is not active can be checked without
  switching to it. On Azure DevOps the credential is per organization: the card's Test checks
  each organization with a stored PAT and then each one a pin or open Ship pane names, one line
  each ("<org>: Signed in as <display name>."), a row's Test checks only its own organization,
  and with no organization to check it says to open an Azure DevOps repo first. A test bypasses
  the response cache, so it reaches the host every time.
- **Token form.** A password field (`type="password"`, `autocomplete="off"`) with **Save** and
  **Cancel**, and a hint that `bb auth bitbucket` (or `bb auth azure-devops <org>`) stores one from
  a terminal. For Azure DevOps a required Organization field, with a `dev.azure.com/` prefix, sits
  above it: Replace fills it from its row, and Add token with the first
  organization a pin or open Ship pane names that has no stored PAT. The value goes to the
  core once, as the argument of `forge_set_token(provider, org, token)`, and the page keeps no copy:
  the field is emptied on save, cancel, when the tab is hidden, and when the dialog closes. Escape
  cancels an open form before it closes the dialog. A failed save shows its error in the form.
- **Changes.** A successful switch, sign-out, save, or removal drops the host's cached credentials
  in the core and emits `forge://auth-changed` (3.20); open Ship panes, the Overview, and the tab
  itself refresh on it. The account chip's per-repo `credential.username` behavior is separate and
  is unchanged.
- **Entry points.** **Accounts** in a drilled Ship bar and in the Overview bar; **Manage
  accounts** in the account chip's menu (the chip shows only with two or more accounts, and not on
  a remote pin); the notice buttons **Manage accounts** (GitHub and GitLab `signedOut` and
  `notInstalled`), **Add token** (Bitbucket and Azure DevOps `signedOut`), and **Replace token** (a
  refused token, and `forbidden`), the last two opening the card with the token form open, and for
  Azure DevOps with the repo's organization filled in; the same buttons on an Overview row's error
  line; and the command palette's "Manage code host accounts" (`showAccounts`, no default key). A
  button that names a host opens the tab, expands More hosts when the card is folded there, and
  scrolls that host's card into view; a host the core had not listed is asked for, so the request
  always lands on a card. The Overview's bar button leaves the choice to the tab.
