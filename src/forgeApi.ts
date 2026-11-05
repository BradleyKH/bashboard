// Front-end side of the Forge pane's Tauri commands (docs/design.md section 4.20; the Rust side is
// section 3.20). The types mirror the Rust DTOs, which serialize camelCase with `Option` as null.
import { invoke } from '@tauri-apps/api/core';

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

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  author: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
  reviewDecision: ReviewState | null;
  reviewers: Reviewer[];
  checks: RunStatus | null;
  isMine: boolean;
  /** The viewer is a requested reviewer who has not reviewed. */
  reviewRequested: boolean;
}

/** One page of open pull requests plus the host's count of all of them. */
export interface PullList {
  items: PullRequest[];
  /** The host's count of open pull requests; null when the host does not say. */
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

/** Open pull requests, at most 50, with the host's count of all open ones. */
export function forgePulls(root: string): Promise<PullList> {
  return invoke<PullList>('forge_pulls', { root });
}

/** Sets the repo's `credential.username` to one of `accounts` and returns the re-resolved repo. */
export function forgeSetAccount(root: string, user: string): Promise<ForgeRepo> {
  return invoke<ForgeRepo>('forge_set_account', { root, user });
}
