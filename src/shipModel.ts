// Run statuses, polling, grouping, log cleanup, and the setup notices for the Ship pane (docs/design.md
// section 4.20). Pure, no DOM.
import type {
  Capabilities,
  ForgeError,
  ForgeRepo,
  ProviderKind,
  PullChecks,
  PullRequest,
  Run,
  RunStatus,
} from './forgeApi';

export type ShipTab = 'pipelines' | 'pulls';

export interface StatusInfo {
  label: string;
  /** The status itself, for a `ship-status--<modifier>` class. */
  modifier: string;
  /** Queued or running: the run is still moving, so it is polled faster and its finish is announced. */
  active: boolean;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting for approval',
  success: 'Passed',
  failure: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  other: 'Unknown',
};

export function statusInfo(status: RunStatus): StatusInfo {
  return { label: STATUS_LABELS[status], modifier: status, active: status === 'queued' || status === 'running' };
}

export function isActive(runs: readonly Run[]): boolean {
  return runs.some((r) => statusInfo(r.status).active);
}

/** Seconds between run polls: faster while something is moving, never under the host's floor. */
export function pollSecs(caps: Capabilities, runs: readonly Run[]): number {
  return Math.max(caps.minPollSecs, isActive(runs) ? 15 : 60);
}

/**
 * `pulls` with `found` merged in by id. Every pending one is settled, found or not, so a failed
 * or partial answer leaves no row waiting forever.
 */
export function withPullChecks(pulls: readonly PullRequest[], found: readonly PullChecks[]): PullRequest[] {
  const byId = new Map(found.map((f) => [f.id, f.checks]));
  return pulls.map((p) =>
    p.checksPending ? { ...p, checks: byId.get(p.id) ?? p.checks, checksPending: false } : p,
  );
}

/** Seconds between pull request polls; they change slowly and cost more on some hosts. */
export function pullPollSecs(caps: Capabilities): number {
  return Math.max(caps.minPollSecs * 4, 60);
}

/**
 * Runs that were queued or running in `prev` and are done in `next`, matched by id. Empty when
 * `prev` is undefined, so a first load never announces anything. A run that moved on to
 * `waiting` has not finished.
 */
export function finishedSince(prev: readonly Run[] | undefined, next: readonly Run[]): Run[] {
  if (prev === undefined) return [];
  const wasActive = new Set(prev.filter((r) => statusInfo(r.status).active).map((r) => r.id));
  return next.filter((r) => wasActive.has(r.id) && !statusInfo(r.status).active && r.status !== 'waiting');
}

const FINISH_VERBS: Partial<Record<RunStatus, string>> = {
  success: 'passed',
  failure: 'failed',
  cancelled: 'was cancelled',
  skipped: 'was skipped',
};

/** "Workflow run passed: CI on main". */
export function finishToast(run: Run, runNoun: string): string {
  const noun = runNoun.charAt(0).toUpperCase() + runNoun.slice(1);
  const verb = FINISH_VERBS[run.status] ?? 'finished';
  const what = run.name || run.title;
  return `${noun} ${verb}: ${what}${run.branch ? ` on ${run.branch}` : ''}`;
}

function parseTime(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "45s", "3m 12s", "1h 5m". */
function formatSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** How long a run took, or has been going; blank when it never started. `now` is epoch milliseconds. */
export function duration(run: Run, now: number): string {
  const start = parseTime(run.startedAt) ?? (statusInfo(run.status).active ? parseTime(run.createdAt) : null);
  if (start === null) return '';
  const end = parseTime(run.finishedAt) ?? (run.status === 'running' ? now : null);
  return end === null ? '' : formatSpan(end - start);
}

/** "just now", "5m ago", "3h ago", "2d ago", "4mo ago", "2y ago". `now` is epoch milliseconds. */
export function relativeTime(iso: string, now: number): string {
  const t = parseTime(iso);
  if (t === null) return '';
  const s = Math.floor((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(m, 1)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export type PullGroupKey = 'reviewRequested' | 'yours' | 'others';

export interface PullGroup {
  key: PullGroupKey;
  title: string;
  pulls: PullRequest[];
}

const GROUP_TITLES: Record<PullGroupKey, string> = {
  reviewRequested: 'Review requested',
  yours: 'Yours',
  others: 'Others',
};

/** Review requested first (a request wins over ownership), then Yours, then Others; empty groups are left out. */
export function groupPulls(pulls: readonly PullRequest[]): PullGroup[] {
  const buckets: Record<PullGroupKey, PullRequest[]> = { reviewRequested: [], yours: [], others: [] };
  for (const p of pulls) {
    buckets[p.reviewRequested ? 'reviewRequested' : p.isMine ? 'yours' : 'others'].push(p);
  }
  // Open before merged or closed, and drafts after the rest of the open ones.
  const rank = (p: PullRequest) => (p.state !== 'open' ? 2 : p.draft ? 1 : 0);
  const order = (a: PullRequest, b: PullRequest) =>
    rank(a) - rank(b) ||
    (parseTime(b.updatedAt) ?? 0) - (parseTime(a.updatedAt) ?? 0) ||
    b.number - a.number;
  const keys: PullGroupKey[] = ['reviewRequested', 'yours', 'others'];
  return keys
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, title: GROUP_TITLES[key], pulls: buckets[key].sort(order) }));
}

/**
 * The note under the pull request groups when the host has more than the list shows, else null.
 * `openOnly` says whether the list holds open ones only or every state.
 */
export function pullLimitNote(shown: number, total: number | null, noun: string, openOnly = true): string | null {
  if (total === null || total <= shown) return null;
  return `Showing the latest ${shown} of ${total}${openOnly ? ' open' : ''} ${noun}s.`;
}

// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// GitHub prefixes every log line with a timestamp like 2026-11-04T10:15:30.1234567Z.
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/** A job log as plain lines: no ANSI escapes, no leading timestamps, no byte order mark or CRs. */
export function cleanLog(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.replace(LOG_TIMESTAMP, ''))
    .join('\n');
}

// Notices.

/** Scopes for a Bitbucket API token, with what each is for. Unconfirmed names are fixed here once checked. */
export const BITBUCKET_SCOPE_INFO: readonly ScopeLine[] = [
  { scope: 'read:repository:bitbucket', purpose: 'find the repository' },
  { scope: 'read:pullrequest:bitbucket', purpose: 'list pull requests' },
  { scope: 'read:pipeline:bitbucket', purpose: 'list pipeline runs, steps, and logs' },
  { scope: 'write:pipeline:bitbucket', purpose: 're-run and stop pipelines', optional: true },
  { scope: 'read:user:bitbucket', purpose: 'tell which pull requests are yours or await your review' },
];

export const BITBUCKET_SCOPES: readonly string[] = BITBUCKET_SCOPE_INFO.map((s) => s.scope);

/** Scopes for an Azure DevOps personal access token, with what each is for. */
export const AZURE_DEVOPS_SCOPE_INFO: readonly ScopeLine[] = [
  { scope: 'Code (Read)', purpose: 'find the repository, list pull requests, and read their policy checks' },
  { scope: 'Build (Read & execute)', purpose: 'list builds, steps, and logs, and cancel or re-run them' },
];

export const AZURE_DEVOPS_SCOPES: readonly string[] = AZURE_DEVOPS_SCOPE_INFO.map((s) => s.scope);

export const BITBUCKET_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const GITHUB_CLI_URL = 'https://cli.github.com';
const GITLAB_CLI_URL = 'https://gitlab.com/gitlab-org/cli';

export type NoticeAction =
  | { kind: 'runTerminal'; label: string; argv: string[] }
  | { kind: 'openUrl'; label: string; url: string }
  | { kind: 'copyText'; label: string; text: string }
  | { kind: 'pickAccount'; label: string }
  | { kind: 'openAccounts'; label: string; host: string; openTokenForm?: boolean; org?: string }
  | { kind: 'retry'; label: string };

export interface ScopeLine {
  scope: string;
  /** A verb phrase that finishes "to ...", for example "list pull requests". */
  purpose: string;
  /** Bashboard works without this scope; it only enables an extra. */
  optional?: boolean;
}

/** What a host calls a pull request; the plain default until a repo resolves, so a stale host's noun never lingers. */
export function prNounOf(repo: ForgeRepo | null | undefined): string {
  return repo?.capabilities.prNoun ?? 'pull request';
}

/** The text after a scope name: `to <purpose>`, marked when the scope is optional. */
export function scopePurposeText(s: ScopeLine): string {
  return `to ${s.purpose}${s.optional ? ' (optional)' : ''}`;
}

export interface Notice {
  title: string;
  /** Short paragraphs. */
  body: string[];
  /** A numbered list shown after the body. */
  steps: string[];
  /** The scopes to tick, shown after the steps. */
  scopes: ScopeLine[];
  /** When set, the steps and scopes sit collapsed under this summary. */
  collapsedLabel: string | null;
  actions: NoticeAction[];
}

const RETRY: NoticeAction = { kind: 'retry', label: 'Retry' };

function notice(title: string, body: string[], actions: NoticeAction[], extra: Partial<Notice> = {}): Notice {
  return { title, body, steps: [], scopes: [], collapsedLabel: null, actions, ...extra };
}

/** The provider an error belongs to: the repo's when known, else a guess from the sign-in command. */
function providerOf(err: ForgeError, repo: ForgeRepo | null | undefined): ProviderKind | null {
  if (repo) return repo.provider;
  const argv = err.signIn ?? [];
  const program = argv[0]?.toLowerCase();
  // `bb` serves both Bitbucket and Azure DevOps; its provider argument says which.
  if (program === 'bb') {
    if (argv[2] === 'bitbucket') return 'bitbucket';
    if (argv[2] === 'azure-devops') return 'azureDevOps';
    return null;
  }
  if (program === 'glab') return 'gitlab';
  if (program === 'az') return 'azureDevOps';
  // The same winget argv shape installs either CLI; the package id tells them apart.
  if (program === 'winget') return argv.includes('GLab.GLab') ? 'gitlab' : 'github';
  if (program === 'gh') return 'github';
  return null;
}

function hostOf(err: ForgeError, repo: ForgeRepo | null | undefined): string {
  if (repo) return repo.host;
  const i = err.signIn?.indexOf('--hostname') ?? -1;
  const named = i >= 0 ? err.signIn?.[i + 1] : undefined;
  return named ?? (providerOf(err, repo) === 'gitlab' ? 'gitlab.com' : 'github.com');
}

/**
 * The Azure DevOps organization the error is about: the sign-in argv names it, else the repo's web
 * URL does (`dev.azure.com/<org>/...` or `<org>.visualstudio.com`). Null when neither is known.
 */
function azureOrgOf(err: ForgeError, repo: ForgeRepo | null | undefined): string | null {
  const argv = err.signIn;
  if (argv?.[0]?.toLowerCase() === 'bb' && argv[3]) return argv[3];
  if (!repo?.webUrl) return null;
  try {
    const url = new URL(repo.webUrl);
    const host = url.hostname.toLowerCase();
    if (host.endsWith('.visualstudio.com')) return host.slice(0, -'.visualstudio.com'.length) || null;
    const first = url.pathname.split('/').filter(Boolean)[0];
    return first ? decodeURIComponent(first) : null;
  } catch {
    return null;
  }
}

function hostOfUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function waitText(secs: number | null): string {
  if (secs === null) return 'shortly';
  if (secs < 60) return `in ${Math.max(secs, 1)} seconds`;
  if (secs < 3600) return `in about ${Math.ceil(secs / 60)} minutes`;
  return `in about ${Math.ceil(secs / 3600)} hours`;
}

// The host is fixed rather than read from the error: `hostOf` falls back to github.com, and the
// Overview builds notices with no repo before its first poll.
function bitbucketActions(lead: 'Add token' | 'Replace token'): NoticeAction[] {
  return [
    { kind: 'openAccounts', label: lead, host: 'bitbucket.org', openTokenForm: true },
    { kind: 'openUrl', label: 'Open the API token page', url: BITBUCKET_TOKEN_URL },
    { kind: 'copyText', label: 'Copy scopes', text: BITBUCKET_SCOPES.join(' ') },
    RETRY,
  ];
}

const AZURE_DEVOPS_HOST = 'dev.azure.com';
const AZ_LOGIN: NoticeAction = { kind: 'runTerminal', label: 'Sign in with Azure CLI', argv: ['az', 'login'] };

// The Azure CLI sign-in is offered only when the core found `az`; otherwise the button would open a
// terminal that fails.
function azureDevOpsActions(
  lead: 'Add token' | 'Replace token',
  org: string | null,
  azCli: boolean,
): NoticeAction[] {
  const tokenUrl = org ? `https://dev.azure.com/${encodeURIComponent(org)}/_usersSettings/tokens` : 'https://dev.azure.com';
  return [
    { kind: 'openAccounts', label: lead, host: AZURE_DEVOPS_HOST, openTokenForm: true, ...(org ? { org } : {}) },
    { kind: 'openUrl', label: 'Open the token page', url: tokenUrl },
    { kind: 'copyText', label: 'Copy scopes', text: AZURE_DEVOPS_SCOPES.join(', ') },
    ...(azCli ? [AZ_LOGIN] : []),
    RETRY,
  ];
}

function azureDevOpsSteps(org: string | null): string[] {
  return [
    'Open the token page and choose New Token.',
    'Name it "Bashboard" and pick the organization and an expiry.',
    'Choose Custom defined scopes and tick the scopes listed below.',
    `Create it, copy it, and choose Add token here (or run bb auth azure-devops ${org ?? '<organization>'} in a terminal).`,
  ];
}

function azureDevOpsScopes(): ScopeLine[] {
  return AZURE_DEVOPS_SCOPE_INFO.map((s) => ({ ...s }));
}

const BITBUCKET_STEPS = [
  'Open the API token page and choose Create API token with scopes.',
  'Name it "Bashboard", pick an expiry, and choose the Bitbucket app.',
  'Tick the scopes listed below.',
  'Create it, copy it, and choose Add token here (or run bb auth bitbucket in a terminal).',
];

function bitbucketScopes(): ScopeLine[] {
  return BITBUCKET_SCOPE_INFO.map((s) => ({ ...s }));
}

function signedOutNotice(err: ForgeError, repo: ForgeRepo | null | undefined): Notice {
  const provider = providerOf(err, repo);
  if (provider === 'bitbucket') {
    // The Rust side words the two cases differently; a stored token that was refused says "rejected".
    if (/rejected/i.test(err.message)) {
      return notice(
        'Bitbucket rejected the stored API token.',
        ['It may have expired, or it may be missing a scope.'],
        bitbucketActions('Replace token'),
        { steps: BITBUCKET_STEPS, scopes: bitbucketScopes(), collapsedLabel: 'How to make a new one' },
      );
    }
    return notice(
      'Bitbucket needs an API token.',
      [
        'Bitbucket has no official command line tool, and Git Credential Manager\'s sign-in cannot read pipelines or pull requests, so Bashboard uses an API token.',
        'Bashboard sends the token to the Bitbucket REST API as a Bearer token and keeps it in Windows Credential Manager.',
      ],
      bitbucketActions('Add token'),
      { steps: BITBUCKET_STEPS, scopes: bitbucketScopes() },
    );
  }
  if (provider === 'azureDevOps') {
    const org = azureOrgOf(err, repo);
    // The Rust side words the two cases differently; a stored token that was refused says "rejected".
    if (/rejected/i.test(err.message)) {
      return notice(
        'Azure DevOps rejected the token.',
        [err.message, 'It may have expired, been made for another organization, or be missing a scope.'],
        azureDevOpsActions('Replace token', org, err.azCli === true),
        { steps: azureDevOpsSteps(org), scopes: azureDevOpsScopes(), collapsedLabel: 'How to make a new one' },
      );
    }
    return notice(
      'Azure DevOps needs a personal access token.',
      [
        err.message,
        'Bashboard sends the token to the Azure DevOps REST API and keeps it in Windows Credential Manager.' +
          (err.azCli === true ? ' Signing in with the Azure CLI also works.' : ''),
      ],
      azureDevOpsActions('Add token', org, err.azCli === true),
      { steps: azureDevOpsSteps(org), scopes: azureDevOpsScopes() },
    );
  }
  if (provider === 'gitlab') {
    const host = hostOf(err, repo);
    const argv = err.signIn ?? ['glab', 'auth', 'login', '--hostname', host];
    return notice(`Sign in to ${host} with the GitLab CLI.`, [err.message], [
      { kind: 'runTerminal', label: 'Sign in', argv },
      { kind: 'openAccounts', label: 'Manage accounts', host },
      RETRY,
    ]);
  }
  if (provider === 'github') {
    const host = hostOf(err, repo);
    const argv = err.signIn ?? ['gh', 'auth', 'login', '--hostname', host, '--web'];
    return notice(`Sign in to ${host} with the GitHub CLI.`, [err.message], [
      { kind: 'runTerminal', label: 'Sign in', argv },
      { kind: 'openAccounts', label: 'Manage accounts', host },
      RETRY,
    ]);
  }
  return notice('Not signed in', [err.message], [RETRY]);
}

/**
 * The in-pane setup guide for an error: what happened and the buttons that do the next step.
 * `repo` is null before the repo has resolved, in which case the provider is read from the error.
 */
export function noticeFor(err: ForgeError, repo: ForgeRepo | null | undefined): Notice {
  const provider = providerOf(err, repo);
  switch (err.kind) {
    case 'notInstalled': {
      if (provider === 'gitlab') {
        const glabActions: NoticeAction[] = [];
        if (err.signIn) glabActions.push({ kind: 'runTerminal', label: 'Install with winget', argv: err.signIn });
        glabActions.push(
          { kind: 'openUrl', label: 'Open the GitLab CLI page', url: err.url ?? GITLAB_CLI_URL },
          { kind: 'openAccounts', label: 'Manage accounts', host: hostOf(err, repo) },
          RETRY,
        );
        return notice(
          'Bashboard reads GitLab through the GitLab CLI.',
          [
            'The GitLab CLI (glab) was not found. Install it, then restart your terminals so they see it.',
            'After installing, sign in once with glab auth login.',
          ],
          glabActions,
        );
      }
      const actions: NoticeAction[] = [];
      if (err.signIn) actions.push({ kind: 'runTerminal', label: 'Install with winget', argv: err.signIn });
      actions.push(
        { kind: 'openUrl', label: 'Open cli.github.com', url: err.url ?? GITHUB_CLI_URL },
        { kind: 'openAccounts', label: 'Manage accounts', host: hostOf(err, repo) },
        RETRY,
      );
      return notice(
        'Bashboard reads GitHub through the GitHub CLI.',
        [
          'The GitHub CLI (gh) was not found. Install it, then restart your terminals so they see it.',
          'After installing, sign in once with gh auth login.',
        ],
        actions,
      );
    }
    case 'signedOut':
      return signedOutNotice(err, repo);
    case 'notFound': {
      if (provider === 'github' && repo && repo.accounts.length > 1) {
        const as = repo.account ? ` as @${repo.account}` : '';
        return notice(
          `${repo.owner}/${repo.name} wasn't found${as}.`,
          [`The repository may belong to another account signed in to ${repo.host}. Pick the one that has access.`],
          [{ kind: 'pickAccount', label: 'Use another account' }, RETRY],
        );
      }
      return notice('Not found', [err.message], [RETRY]);
    }
    case 'ssoRequired': {
      const actions: NoticeAction[] = [];
      if (err.url) actions.push({ kind: 'openUrl', label: 'Authorize', url: err.url });
      actions.push(RETRY);
      return notice(
        'Single sign-on needs authorizing',
        ['This organization requires SSO. Authorize the token for it, then retry.'],
        actions,
      );
    }
    case 'rateLimited':
      return notice(
        'Rate limit reached',
        [err.message, `Polling resumes ${waitText(err.retryAfterSecs)}.`],
        [RETRY],
      );
    case 'unsupportedHost': {
      // The repo never resolves for an unsupported host, so the host comes from the error's URL.
      const host = repo?.host ?? hostOfUrl(err.url);
      const title = host ? `${host} isn't supported` : "This host isn't supported";
      // The Rust side says "isn't supported yet" for a host it recognized as Bitbucket Data Center,
      // where naming a provider for the host would be wrong advice.
      if (/isn't supported yet/i.test(err.message)) return notice(title, [err.message], [RETRY]);
      const kind = repo?.provider === 'gitlab' ? 'gitlab' : 'github';
      const snippet = `"ship": { "hosts": { "${host ?? 'git.example.com'}": "${kind}" } }`;
      return notice(
        title,
        [
          err.message,
          'If it is a GitHub Enterprise or self-managed GitLab host, add it to settings.json under ship.hosts and name its provider: github or gitlab. Azure DevOps Server and Bitbucket Data Center are not served.',
          snippet,
        ],
        [{ kind: 'copyText', label: 'Copy setting', text: snippet }, RETRY],
      );
    }
    case 'forbidden':
      if (provider === 'bitbucket') {
        return notice(
          'Bitbucket denied the request',
          [err.message, 'The API token may be missing a scope.'],
          bitbucketActions('Replace token'),
          { steps: BITBUCKET_STEPS, scopes: bitbucketScopes(), collapsedLabel: 'How to make a new one' },
        );
      }
      if (provider === 'azureDevOps') {
        const org = azureOrgOf(err, repo);
        return notice(
          'Azure DevOps denied the request',
          [err.message, 'The personal access token may be missing a scope.'],
          azureDevOpsActions('Replace token', org, err.azCli === true),
          { steps: azureDevOpsSteps(org), scopes: azureDevOpsScopes(), collapsedLabel: 'How to make a new one' },
        );
      }
      return notice('Access denied', [err.message], [RETRY]);
    case 'notARepo':
      return notice('Not a git repository', [err.message], []);
    case 'noRemote':
      return notice('No remote', [err.message], [RETRY]);
    case 'network':
      return notice("Can't reach the host", [err.message], [RETRY]);
    case 'other':
      return notice('Something went wrong', [err.message], [RETRY]);
  }
}
