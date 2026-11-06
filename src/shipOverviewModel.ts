// Row building, attention order, dashboard items, and poll timing for the Ship Overview tab
// (docs/design.md section 4.20). Pure, no DOM.
import type { ForgeRepo, OverviewRepo, PinnedRepo, PullRequest, Run } from './forgeApi';
import { isReadyToMerge, statusInfo, type ShipTab } from './shipModel';

/** A branch whose newest run is watched; `run` is null when none of the repo's latest runs is on it. */
export interface HealthBranch {
  branch: string;
  run: Run | null;
}

export interface OverviewRow {
  pin: PinnedRepo;
  overview: OverviewRepo;
  health: HealthBranch[];
}

export type DashboardItem =
  | { kind: 'branch'; target: string; repo: string; tab: ShipTab; branch: string; run: Run }
  | { kind: 'review' | 'mine' | 'approved'; target: string; repo: string; tab: ShipTab; pull: PullRequest };

export const FAST_POLL_MS = 60_000;

/**
 * Overview requests an hour that Bitbucket pins may spend between them, well under Bitbucket's
 * 1,000 an hour per user, since drilled Ship panes and other tools share the same allowance.
 */
const BITBUCKET_HOURLY_BUDGET = 600;
/** A poll's usual cost: the runs, the open pull requests, and the checks of those that changed. */
const REQUESTS_PER_POLL = 3;

/** The key every forge command takes for a pin: its clone when set, else the remote by identity. */
export function targetKey(pin: PinnedRepo): string {
  return pin.root ? pin.root : `remote:${pin.repo}`;
}

/** The pin identity of a repo; the Rust side joins the remote's path segments the same way. */
export function repoId(repo: ForgeRepo): string {
  return `${repo.host.toLowerCase()}/${repo.owner}/${repo.name}`;
}

/** The default branch first, then the open pull requests' targets (deploy branches), then the pin's own. */
export function healthBranches(o: OverviewRepo, pin: PinnedRepo): HealthBranch[] {
  const names: string[] = [];
  const add = (b: string | null | undefined) => {
    if (b && !names.includes(b)) names.push(b);
  };
  add(o.defaultBranch);
  for (const p of o.pulls.items) if (p.state === 'open') add(p.targetBranch);
  for (const b of pin.branches ?? []) add(b);
  // Runs arrive newest first, so the first match is the newest.
  return names.map((branch) => ({ branch, run: o.runs.find((r) => r.branch === branch) ?? null }));
}

export function buildRow(pin: PinnedRepo, overview: OverviewRepo): OverviewRow {
  return { pin, overview, health: healthBranches(overview, pin) };
}

function openPulls(o: OverviewRepo): PullRequest[] {
  return o.pulls.items.filter((p) => p.state === 'open');
}

const isRedBranch = (h: HealthBranch): h is HealthBranch & { run: Run } => h.run?.status === 'failure';
const needsReview = (p: PullRequest) => p.reviewRequested;
const mineNeedsWork = (p: PullRequest) => p.isMine && (p.reviewDecision === 'changesRequested' || p.checks === 'failure');

/** Runs queued or running among the repo's latest 20, on any branch. */
export function runningCount(o: OverviewRepo): number {
  return o.runs.filter((r) => statusInfo(r.status).active).length;
}

/**
 * 1 is most urgent: red branch, review requested, own pull request needing work or ready to merge,
 * branch running, the rest.
 */
export function attentionRank(o: OverviewRepo, health: readonly HealthBranch[]): 1 | 2 | 3 | 4 | 5 {
  const pulls = openPulls(o);
  if (health.some(isRedBranch)) return 1;
  if (pulls.some(needsReview)) return 2;
  if (pulls.some((p) => mineNeedsWork(p) || isReadyToMerge(p))) return 3;
  if (health.some((h) => h.run !== null && statusInfo(h.run.status).active)) return 4;
  return 5;
}

function activityMs(o: OverviewRepo): number {
  const times = [...o.runs.map((r) => r.createdAt), ...o.pulls.items.map((p) => p.updatedAt)]
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
  return times.length === 0 ? 0 : Math.max(...times);
}

/** By attention rank; the quiet rank by latest activity; any remaining tie keeps the input (pin) order. */
export function orderRows(rows: readonly OverviewRow[]): OverviewRow[] {
  return rows
    .map((row, index) => ({
      row,
      index,
      rank: attentionRank(row.overview, row.health),
      activity: activityMs(row.overview),
    }))
    .sort((a, b) => a.rank - b.rank || (a.rank === 5 ? b.activity - a.activity : 0) || a.index - b.index)
    .map((e) => e.row);
}

/**
 * What the dashboard shows, row by row in the order given: a row's red branches, then its pull
 * requests to review, fix, or merge.
 */
export function dashboardItems(rows: readonly OverviewRow[]): DashboardItem[] {
  const items: DashboardItem[] = [];
  for (const { pin, overview, health } of rows) {
    const target = targetKey(pin);
    const repo = pin.repo;
    for (const h of health) {
      if (isRedBranch(h)) items.push({ kind: 'branch', target, repo, tab: 'pipelines', branch: h.branch, run: h.run });
    }
    for (const pull of openPulls(overview)) {
      // A request for the viewer's review wins over ownership, as in the Pull requests tab's groups.
      if (needsReview(pull)) items.push({ kind: 'review', target, repo, tab: 'pulls', pull });
      else if (mineNeedsWork(pull)) items.push({ kind: 'mine', target, repo, tab: 'pulls', pull });
      else if (isReadyToMerge(pull)) items.push({ kind: 'approved', target, repo, tab: 'pulls', pull });
    }
  }
  return items;
}

/** Is a pin id (`host/owner/name`) on Bitbucket, read from its host. */
export function isBitbucketPin(repoId: string): boolean {
  return repoId.split('/')[0].toLowerCase().includes('bitbucket');
}

/** The shortest gap between one Bitbucket pin's polls that keeps all `pins` of them inside the budget. */
export function bitbucketFloorMs(pins: number): number {
  return Math.ceil((pins * REQUESTS_PER_POLL * 3_600_000) / BITBUCKET_HOURLY_BUDGET);
}

/**
 * 60s while any of the latest runs is moving, so the row's running count clears promptly; else the
 * heartbeat; null when that is off (0). Either is stretched to `floorMs`, the gap a host's request
 * budget needs.
 */
export function nextPollMs(runs: readonly Run[], heartbeatMinutes: number, floorMs = 0): number | null {
  if (runs.some((r) => statusInfo(r.status).active)) return Math.max(FAST_POLL_MS, floorMs);
  return heartbeatMinutes > 0 ? Math.max(heartbeatMinutes * 60_000, floorMs) : null;
}
