import type { BranchSize } from './branchSizeApi';
import { badgeTitle, isOverThreshold, meterFraction, sizeSummary } from './branchSizeModel';
import type { PullRequest } from './forgeApi';
import { approvedByText } from './shipModel';
import type { WorktreeDetail } from './worktreeApi';

/** Pure rows for the dashboard's Branch section. No DOM. */

export type BranchSectionState =
  /** The followed folder is not a repo: the section is hidden. */
  | { kind: 'none' }
  | {
      kind: 'repo';
      worktree: string;
      branch: string | null;
      detail: WorktreeDetail | null;
      size: BranchSize | null;
      threshold: number;
      ci: { label: string; status: string; url: string | null } | null;
      /** The branch's pull request, from `pickPull`; null when it has none or the host cannot be read. */
      pull: PullRequest | null;
    };

export type BranchRow =
  | {
      kind: 'meter';
      text: string;
      title: string;
      /** Share of the threshold used, 0..1; null when the threshold is off, which shows the number alone. */
      fraction: number | null;
      over: boolean;
    }
  | {
      kind: 'text';
      id: 'ahead' | 'upstream' | 'tree' | 'no-comparison';
      text: string;
      tone: 'normal' | 'muted' | 'warn';
    }
  | { kind: 'ci'; label: string; status: string; title: string }
  | {
      kind: 'pull';
      /** "#95 Fix the parser". */
      label: string;
      /** Draft, Merged, Closed, or the review decision; null when there is nothing to say. */
      badge: string | null;
      /** A `ship-badge--*` or `ship-review--*` modifier for the badge's color. */
      tone: 'draft' | 'merged' | 'closed' | 'approved' | 'changesRequested' | 'pending' | null;
      /** Merged or closed: shown as history. */
      done: boolean;
      title: string;
    };

export interface BranchSectionView {
  /** The branch name, or "detached HEAD". */
  name: string;
  /** The worktree folder's name. */
  folder: string;
  /** Hover text for the header: the full worktree path. */
  title: string;
  rows: BranchRow[];
}

/** The last path segment, for either separator; an empty or root-only path falls back to the whole path. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p !== '');
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function branchSectionView(state: BranchSectionState): BranchSectionView | null {
  if (state.kind === 'none') return null;
  const { worktree, branch, detail, size, threshold, ci, pull } = state;
  const rows: BranchRow[] = [];

  // detail names the comparison the ahead/behind counts use; size is the fallback while detail loads.
  const comparison = detail ? detail.comparison : size ? size.comparison : undefined;
  if (comparison === null) {
    rows.push({ kind: 'text', id: 'no-comparison', text: 'no comparison ref', tone: 'muted' });
  } else {
    if (size !== null && size.comparison !== null) {
      rows.push({
        kind: 'meter',
        text: sizeSummary(size),
        title: badgeTitle(size),
        fraction: meterFraction(size, threshold),
        over: isOverThreshold(size, threshold),
      });
    }
    if (detail !== null && comparison !== undefined) {
      rows.push({
        kind: 'text',
        id: 'ahead',
        text: `ahead ${detail.ahead}, behind ${detail.behind} against ${comparison}`,
        tone: 'normal',
      });
    }
  }

  if (detail !== null) {
    const upstream = upstreamRow(detail);
    if (upstream !== null) rows.push(upstream);
  }

  if (detail !== null && detail.staged + detail.changed + detail.untracked > 0) {
    rows.push({
      kind: 'text',
      id: 'tree',
      text: `${detail.staged} staged, ${detail.changed} changed, ${detail.untracked} untracked`,
      tone: 'normal',
    });
  }

  if (ci !== null) {
    rows.push({
      kind: 'ci',
      label: ci.label,
      status: ci.status,
      title: ci.url === null ? 'Open the Ship tab' : `${ci.url}\nOpen the Ship tab`,
    });
  }

  if (pull !== null) rows.push(pullRow(pull));

  return { name: branch ?? 'detached HEAD', folder: folderName(worktree), title: worktree, rows };
}

/**
 * Whether the branch's commits are on its remote: "origin/feat: 2 to push, 1 to pull". Null on a
 * detached HEAD, and when the upstream is the comparison ref, whose counts the ahead row already shows.
 */
function upstreamRow(detail: WorktreeDetail): BranchRow | null {
  if (detail.branch === null) return null;
  const text = (t: string, tone: 'normal' | 'muted' | 'warn'): BranchRow => ({ kind: 'text', id: 'upstream', text: t, tone });
  const { upstream } = detail;
  if (upstream === null) return text('no upstream: not pushed', 'muted');
  if (detail.upstreamGone) return text(`${upstream}: deleted on the remote`, 'warn');
  if (upstream === detail.comparison) return null;
  const parts: string[] = [];
  if (detail.upstreamAhead > 0) parts.push(`${detail.upstreamAhead} to push`);
  if (detail.upstreamBehind > 0) parts.push(`${detail.upstreamBehind} to pull`);
  if (parts.length === 0) return text(`${upstream}: up to date`, 'muted');
  return text(`${upstream}: ${parts.join(', ')}`, 'normal');
}

/**
 * The pull request to show for a branch: the newest open one, else the newest merged or closed
 * one, so a merged branch says so. Null when the branch has none.
 */
export function pickPull(pulls: readonly PullRequest[], branch: string): PullRequest | null {
  let best: PullRequest | null = null;
  for (const p of pulls) {
    if (p.sourceBranch !== branch) continue;
    if (best === null) {
      best = p;
      continue;
    }
    const open = p.state === 'open';
    const bestOpen = best.state === 'open';
    if (open !== bestOpen ? open : p.updatedAt > best.updatedAt) best = p;
  }
  return best;
}

const REVIEW_LABELS = { approved: 'approved', changesRequested: 'changes requested', pending: 'review pending' };

function pullRow(pull: PullRequest): BranchRow {
  let badge: string | null = null;
  let tone: Extract<BranchRow, { kind: 'pull' }>['tone'] = null;
  if (pull.state === 'merged' || pull.state === 'closed') {
    badge = pull.state;
    tone = pull.state;
  } else if (pull.draft) {
    badge = 'draft';
    tone = 'draft';
  } else if (pull.reviewDecision !== null) {
    badge = REVIEW_LABELS[pull.reviewDecision];
    tone = pull.reviewDecision;
  }
  const lines = [pull.title, `${pull.sourceBranch} → ${pull.targetBranch}`];
  if (pull.state === 'open' && pull.reviewDecision === 'approved') lines.push(approvedByText(pull));
  if (pull.webUrl) lines.push(pull.webUrl);
  lines.push('Open the Ship tab');
  return {
    kind: 'pull',
    label: `#${pull.number} ${pull.title}`,
    badge,
    tone,
    done: pull.state !== 'open',
    title: lines.join('\n'),
  };
}

/** True when two views would render identically, so the DOM can be left alone. */
export function sameView(a: BranchSectionView | null, b: BranchSectionView | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
