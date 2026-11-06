// What the dashboard's Ship section shows (docs/design/dashboard.md section 4.6). Pure, no DOM.
import type { Run, RunStatus } from './forgeApi';
import { approvedByText, isReadyToMerge, relativeTime, statusInfo, type ShipTab } from './shipModel';
import { isBitbucketPin, targetKey, type DashboardItem, type OverviewRow } from './shipOverviewModel';
import { providerBadge } from './shipOverviewText';
import type { OverviewEntry } from './shipOverviewStore';

/** Review requests past this many are counted on the pull request line instead of getting rows. */
export const REVIEW_ROW_CAP = 5;

/** A row that is not one item: the running pipelines line and the open pull requests line. */
export interface SummaryLine {
  status: RunStatus;
  /** `owner/name` when the line is about one repo. */
  repo: string | null;
  text: string;
  title: string;
  /** Null opens the Overview itself. */
  target: string | null;
  tab?: ShipTab;
}

interface RunningRun {
  target: string;
  repo: string;
  run: Run;
}

/** `owner/name` from a pin identity (`<host>/<path segments>`); the host is kept off the narrow dashboard. */
export function repoLabel(repo: string): string {
  const i = repo.indexOf('/');
  return i < 0 ? repo : repo.slice(i + 1);
}

export function itemText(item: DashboardItem): string {
  if (item.kind === 'branch') return `${item.branch} failed`;
  const n = `#${item.pull.number}`;
  if (item.kind === 'review') return `${n} needs your review`;
  if (item.kind === 'approved') return `${n} ${approvedByText(item.pull)}`;
  return item.pull.reviewDecision === 'changesRequested' ? `${n} changes requested` : `${n} checks failing`;
}

/** The status icon's state: an approval passed, a review request has no state of its own, the rest failed. */
export function itemStatus(item: DashboardItem): RunStatus {
  if (item.kind === 'approved') return 'success';
  return item.kind === 'review' ? 'other' : 'failure';
}

/** The failing run's title or the pull request's title, for the row's tooltip. */
export function itemTitle(item: DashboardItem): string {
  return item.kind === 'branch' ? item.run.title : item.pull.title;
}

/**
 * The item rows: every failure first, in the order given, then the viewer's approved pull requests,
 * then the first `REVIEW_ROW_CAP` review requests. `reviewCount` counts all of them, for the pull
 * request line.
 */
export function sectionItems(items: readonly DashboardItem[]): { shown: DashboardItem[]; reviewCount: number } {
  const of = (kind: 'review' | 'approved') => items.filter((i) => i.kind === kind);
  const reviews = of('review');
  return {
    shown: [...items.filter((i) => i.kind !== 'review' && i.kind !== 'approved'), ...of('approved'), ...reviews.slice(0, REVIEW_ROW_CAP)],
    reviewCount: reviews.length,
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One run moving: that run's repo, branch, pipeline, and start. Several: their count, opening their
 * repo's Pipelines when they share one, else the Overview. Counts only each repo's newest 20 runs.
 */
export function runningLine(rows: readonly OverviewRow[], now: number): SummaryLine {
  const running: RunningRun[] = rows.flatMap((r) =>
    r.overview.runs
      .filter((run) => statusInfo(run.status).active)
      .map((run) => ({ target: targetKey(r.pin), repo: r.pin.repo, run })),
  );
  if (running.length === 1) {
    const { target, repo, run } = running[0];
    const started = relativeTime(run.startedAt ?? run.createdAt, now);
    return {
      status: run.status,
      repo: repoLabel(repo),
      text: [run.branch, run.name, started].filter(Boolean).join(' · '),
      title: run.title,
      target,
      tab: 'pipelines',
    };
  }
  const repos = new Set(running.map((r) => r.target));
  const status: RunStatus = running.some((r) => r.run.status === 'running') ? 'running' : running.length > 0 ? 'queued' : 'other';
  const text = `${plural(running.length, 'pipeline')} running`;
  if (repos.size === 1) {
    const { target, repo } = running[0];
    return { status, repo: repoLabel(repo), text, title: 'Open its Pipelines', target, tab: 'pipelines' };
  }
  return {
    status,
    repo: null,
    text: repos.size > 1 ? `${text} in ${repos.size} repos` : text,
    title: 'Open the Ship Overview',
    target: null,
  };
}

/**
 * Open non-draft pull requests across the rows, with the review request count when some lack a
 * row. Null when every one of them already has a review or approved row. Counts only each repo's
 * newest 50.
 */
export function pullsLine(rows: readonly OverviewRow[], reviewCount: number): SummaryLine | null {
  const open = rows.flatMap((r) => r.overview.pulls.items).filter((p) => p.state === 'open' && !p.draft);
  const untagged = open.filter((p) => !p.reviewRequested && !isReadyToMerge(p)).length;
  if (untagged === 0 && reviewCount <= REVIEW_ROW_CAP) return null;
  const overflow = reviewCount > REVIEW_ROW_CAP ? `, ${reviewCount} need your review` : '';
  return {
    status: 'other',
    repo: null,
    text: `${plural(open.length, 'open PR')}${overflow}`,
    title: 'Open pull requests across the pinned repos, drafts left out',
    target: null,
  };
}

/** The sign-in row: which host the Accounts tab opens on, null to let the tab choose. */
export interface SignInLine {
  text: string;
  title: string;
  host: string | null;
  /** Bitbucket and Azure DevOps sign in with a pasted token, so their row opens straight to that form. */
  openTokenForm: boolean;
  /** The Azure DevOps organization the pins share, so the form can prefill it. */
  org?: string;
}

const AZURE_DEVOPS_HOST = 'dev.azure.com';

/** The organization of an Azure DevOps pin id: `dev.azure.com/<org>/...`, or the subdomain of a legacy host. */
function azureOrgOfPin(repoId: string): string | null {
  const [host, first] = repoId.split('/');
  const lower = host.toLowerCase();
  const org = lower.endsWith('.visualstudio.com') ? host.slice(0, -'.visualstudio.com'.length) : first;
  if (!org) return null;
  try {
    return decodeURIComponent(org);
  } catch {
    return org;
  }
}

/**
 * A row asking the viewer to sign in, when some pin's last poll failed for want of an account
 * (signed out, or the GitHub CLI missing). Null when none did. Names the repo when it is the only
 * one, and the host when every such pin shares one.
 */
export function signInLine(entries: readonly OverviewEntry[]): SignInLine | null {
  const out = entries.filter((e) => e.error?.kind === 'signedOut' || e.error?.kind === 'notInstalled');
  if (out.length === 0) return null;
  // Azure DevOps pins may sit on a legacy `<org>.visualstudio.com` host, but the card is one host.
  const azure = out.every((e) => providerBadge(e.pin.repo)?.name === 'Azure DevOps');
  const hosts = [...new Set(out.map((e) => e.pin.repo.split('/')[0].toLowerCase()))];
  const host = azure ? AZURE_DEVOPS_HOST : hosts.length === 1 ? hosts[0] : null;
  const what = out.length === 1 ? repoLabel(out[0].pin.repo) : plural(out.length, 'pinned repo');
  const orgs = azure ? [...new Set(out.map((e) => azureOrgOfPin(e.pin.repo)))] : [];
  const org = orgs.length === 1 ? orgs[0] : null;
  return {
    text: host ? `Sign in to ${host} for ${what}` : `Sign in for ${what}`,
    title: 'Open the Accounts tab',
    host,
    openTokenForm: host !== null && (azure || out.every((e) => isBitbucketPin(e.pin.repo))),
    ...(org ? { org } : {}),
  };
}
