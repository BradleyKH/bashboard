// Front-end side of the Ship pane's Tauri commands (docs/design.md section 4.20; the Rust side is
// section 3.20). The types mirror the Rust DTOs, which serialize camelCase with `Option` as null.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type ProviderKind = 'github' | 'bitbucket' | 'gitlab' | 'azureDevOps';

/** `waiting` means a person must act (GitHub `action_required`, Bitbucket `PAUSED` or `HALTED`). */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'other';

export type ReviewState = 'approved' | 'changesRequested' | 'pending';

export interface Capabilities {
  rerun: boolean;
  rerunFailed: boolean;
  cancel: boolean;
  jobLogs: boolean;
  drafts: boolean;
  /** "pull request" or "merge request". */
  prNoun: string;
  /** "workflow run", "pipeline", or "build". */
  runNoun: string;
  minPollSecs: number;
  /** The host can hold several signed-in accounts the user picks between; GitHub only for now. */
  accounts: boolean;
}

/** How the repo's account was chosen. */
export type AccountSource = 'repoConfig' | 'remoteUrl' | 'cliActive' | 'only' | 'none';

export interface ForgeRepo {
  provider: ProviderKind;
  host: string;
  owner: string;
  name: string;
  webUrl: string;
  /** The current local branch, null when detached. */
  branch: string | null;
  capabilities: Capabilities;
  account: string | null;
  accountSource: AccountSource;
  /** Every account signed in to this host; empty when not applicable. */
  accounts: string[];
}

export interface Run {
  id: string;
  number: number | null;
  /** Workflow or pipeline name. */
  name: string;
  /** The commit message's first line, or a display title. */
  title: string;
  branch: string | null;
  sha: string | null;
  event: string | null;
  status: RunStatus;
  rawStatus: string;
  actor: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  webUrl: string;
}

export interface Step {
  number: number;
  name: string;
  status: RunStatus;
}

export interface Job {
  id: string;
  name: string;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  webUrl: string | null;
  steps: Step[];
}

/** The last 1 MiB of a job's log when it is longer. */
export interface JobLog {
  text: string;
  truncated: boolean;
}

export interface Reviewer {
  login: string;
  state: ReviewState;
}

export type PullState = 'open' | 'merged' | 'closed';

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  author: string;
  draft: boolean;
  state: PullState;
  sourceBranch: string;
  targetBranch: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
  reviewDecision: ReviewState | null;
  reviewers: Reviewer[];
  checks: RunStatus | null;
  /** `checks` is not known yet; `forgePullChecks` fills it in after the list shows. */
  checksPending: boolean;
  isMine: boolean;
  /** The viewer is a requested reviewer who has not reviewed. */
  reviewRequested: boolean;
}

/** One page of pull requests (open ones, or every state) plus the host's count of all that match. */
export interface PullList {
  items: PullRequest[];
  /** The host's count of the pull requests asked for; null when the host does not say. */
  total: number | null;
}

export type ForgeErrorKind =
  | 'notARepo'
  | 'noRemote'
  | 'unsupportedHost'
  | 'notInstalled'
  | 'signedOut'
  | 'ssoRequired'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'network'
  | 'other';

export interface ForgeError {
  kind: ForgeErrorKind;
  /** Plain user-facing text; never a token or an Authorization header. */
  message: string;
  url: string | null;
  /** Argv to run in a new terminal pane. */
  signIn: string[] | null;
  retryAfterSecs: number | null;
}

const ERROR_KINDS: ReadonlySet<string> = new Set<ForgeErrorKind>([
  'notARepo',
  'noRemote',
  'unsupportedHost',
  'notInstalled',
  'signedOut',
  'ssoRequired',
  'forbidden',
  'notFound',
  'rateLimited',
  'network',
  'other',
]);

/** Turns any rejection into a ForgeError; a non-forge one (a browser-only run) becomes kind `other`. */
export function asForgeError(err: unknown): ForgeError {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.kind === 'string' && ERROR_KINDS.has(e.kind) && typeof e.message === 'string') {
      return {
        kind: e.kind as ForgeErrorKind,
        message: e.message,
        url: typeof e.url === 'string' ? e.url : null,
        signIn: Array.isArray(e.signIn) ? e.signIn.map(String) : null,
        retryAfterSecs: typeof e.retryAfterSecs === 'number' ? e.retryAfterSecs : null,
      };
    }
  }
  const message =
    err instanceof Error ? err.message : typeof err === 'string' && err !== '' ? err : 'Something went wrong.';
  return { kind: 'other', message, url: null, signIn: null, retryAfterSecs: null };
}

export function forgeRepo(root: string): Promise<ForgeRepo> {
  return invoke<ForgeRepo>('forge_repo', { root });
}

/** Newest first, at most 20; a null branch means all branches. */
export function forgeRuns(root: string, branch: string | null): Promise<Run[]> {
  return invoke<Run[]>('forge_runs', { root, branch });
}

export function forgeJobs(root: string, runId: string): Promise<Job[]> {
  return invoke<Job[]>('forge_jobs', { root, runId });
}

export function forgeLog(root: string, runId: string, jobId: string): Promise<JobLog> {
  return invoke<JobLog>('forge_log', { root, runId, jobId });
}

export function forgeRerun(root: string, runId: string, failedOnly: boolean): Promise<void> {
  return invoke<void>('forge_rerun', { root, runId, failedOnly });
}

export function forgeCancel(root: string, runId: string): Promise<void> {
  return invoke<void>('forge_cancel', { root, runId });
}

/**
 * The latest 50 pull requests: open ones only, or with `openOnly` false, every state; a non-null
 * `branch` keeps only those from that source branch.
 */
export function forgePulls(root: string, openOnly: boolean, branch: string | null): Promise<PullList> {
  return invoke<PullList>('forge_pulls', { root, openOnly, branch });
}

/** One pull request's checks, answering a `forgePullChecks` call. */
export interface PullChecks {
  id: string;
  checks: RunStatus | null;
}

/** Checks for the pull requests a `forgePulls` reply marked `checksPending`. */
export function forgePullChecks(root: string, pulls: readonly PullRequest[]): Promise<PullChecks[]> {
  return invoke<PullChecks[]>('forge_pull_checks', {
    root,
    pulls: pulls.map((p) => ({ id: p.id, updatedAt: p.updatedAt })),
  });
}

/** Sets the repo's `credential.username` to one of `accounts` and returns the re-resolved repo. */
export function forgeSetAccount(root: string, user: string): Promise<ForgeRepo> {
  return invoke<ForgeRepo>('forge_set_account', { root, user });
}

/** A repo pinned to the Ship Overview; `repo` (`<host>/<path>`) is its identity, `root` an optional local clone. */
export interface PinnedRepo {
  repo: string;
  root?: string;
  /** Extra branches to watch beyond the default and the open pull requests' targets. */
  branches?: string[];
}

/** One pinned repo's Overview data, fetched in a single call. */
export interface OverviewRepo {
  /** As `forgeRepo` returns it; `branch` is null for a remote target. */
  repo: ForgeRepo;
  defaultBranch: string | null;
  /** Newest 20, all branches. */
  runs: Run[];
  /** Open only; checks may still be pending. */
  pulls: PullList;
}

/** `target` is a clone's path or `remote:<repo>`. */
export function forgeOverviewRepo(target: string): Promise<OverviewRepo> {
  return invoke<OverviewRepo>('forge_overview_repo', { target });
}

// Accounts tab: the credentials behind the pane.

/** The providers that have credentials to manage. */
export type AuthProvider = Extract<ProviderKind, 'github' | 'bitbucket'>;

/** Where the token the pane would use comes from. */
export type TokenSourceKind = 'ghCli' | 'gitCredentialManager' | 'bashboardCredential';

/** One host's sign-in state. Ordered github.com, other GitHub hosts, then bitbucket.org. */
export interface HostAuth {
  provider: AuthProvider;
  host: string;
  /** Whether `gh` was found, on PATH or in its install folders; meaningful for GitHub hosts only. */
  ghInstalled: boolean;
  /** Accounts GitHub CLI holds for this host; empty for Bitbucket. */
  accounts: string[];
  activeAccount: string | null;
  /** The source that would supply the token, null when there is none. */
  tokenSource: TokenSourceKind | null;
  /** Whether the `bashboard:bitbucket.org` credential exists; false for GitHub hosts. */
  bitbucketTokenStored: boolean;
  /** Name (never the value) of the environment variable `gh` would use for this host; null when none is set. */
  ghEnvToken: string | null;
}

/** The result of asking the host who the stored token belongs to. */
export interface AuthCheck {
  ok: boolean;
  login: string | null;
  /** Granted scopes when the host reports them, else null. */
  scopes: string[] | null;
  message: string | null;
}

export function forgeAuthStatus(): Promise<HostAuth[]> {
  return invoke<HostAuth[]>('forge_auth_status');
}

export function forgeAuthTest(provider: AuthProvider, host: string, account?: string): Promise<AuthCheck> {
  return invoke<AuthCheck>('forge_auth_test', { provider, host, account });
}

export function forgeBitbucketSetToken(token: string): Promise<void> {
  return invoke<void>('forge_bitbucket_set_token', { token });
}

/** False when nothing was stored. */
export function forgeBitbucketClearToken(): Promise<boolean> {
  return invoke<boolean>('forge_bitbucket_clear_token');
}

export function forgeGhSwitch(host: string, user: string): Promise<void> {
  return invoke<void>('forge_gh_switch', { host, user });
}

export function forgeGhLogout(host: string, user: string): Promise<void> {
  return invoke<void>('forge_gh_logout', { host, user });
}

/** Fires when a credential for `host` changed, from here or from outside the app. */
export function onForgeAuthChanged(cb: (e: { provider: AuthProvider; host: string }) => void): Promise<UnlistenFn> {
  return listen<{ provider: AuthProvider; host: string }>('forge://auth-changed', (e) => cb(e.payload));
}
