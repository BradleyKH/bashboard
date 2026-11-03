/** Pure helpers behind the Git pane (docs/design.md section 4.13); no DOM. */

import type { GitCommit, GitFileEntry, GitLastFetch, GitStatus } from './gitApi';
import { samePath } from './favorites';

export type GitRowKind = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

export interface GitRow {
  /** `kind:path`, so a file both staged and unstaged has two distinct rows. */
  key: string;
  kind: GitRowKind;
  entry: GitFileEntry;
}

function rowsOf(kind: GitRowKind, entries: readonly GitFileEntry[]): GitRow[] {
  return entries.map((entry) => ({ key: `${kind}:${entry.path}`, kind, entry }));
}

function byPath(a: GitRow, b: GitRow): number {
  return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
}

export function stagedList(status: GitStatus): GitRow[] {
  return rowsOf('staged', status.staged).sort(byPath);
}

/** Unstaged, untracked, and conflicted entries as one list sorted by path. */
export function changesList(status: GitStatus): GitRow[] {
  return [
    ...rowsOf('unstaged', status.unstaged),
    ...rowsOf('untracked', status.untracked),
    ...rowsOf('conflicted', status.conflicted),
  ].sort(byPath);
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/** The branch, its upstream, and the ahead and behind counts as one line. */
export function branchLine(status: GitStatus): string {
  const head = status.branch ?? (status.oid ? `detached at ${shortHash(status.oid)}` : 'detached HEAD');
  if (!status.upstream) return status.branch === null ? head : `${head} (no upstream)`;
  const counts: string[] = [];
  if (status.ahead > 0) counts.push(`${status.ahead} ahead`);
  if (status.behind > 0) counts.push(`${status.behind} behind`);
  const tail = counts.length > 0 ? counts.join(', ') : 'up to date';
  return `${head} -> ${status.upstream}, ${tail}`;
}

export function canCommit(status: GitStatus, message: string): boolean {
  return status.staged.length > 0 && message.trim() !== '';
}

/** The newest commit when it is HEAD, else null. */
export function undoTarget(log: readonly GitCommit[], status: GitStatus): GitCommit | null {
  const newest = log[0];
  if (!newest || newest.hash !== status.oid) return null;
  return newest;
}

/**
 * What a commit row's menu offers for pushing: 'push' on HEAD, 'upTo' on an older unpushed
 * commit, null when the commit is pushed or the branch is detached or has no upstream (the
 * branch row's Publish covers that case).
 */
export function commitPushKind(commit: GitCommit, status: GitStatus | null): 'push' | 'upTo' | null {
  if (commit.pushed || status === null || status.branch === null || status.upstream === null) return null;
  return commit.hash === status.oid ? 'push' : 'upTo';
}

/** The commit box text after undo: the undone message, followed by any draft that was already there. */
export function mergeUndoMessage(undone: string, draft: string): string {
  const message = undone.replace(/\s+$/, '');
  const kept = draft.trim();
  if (kept === '' || kept === message.trim()) return message;
  return `${message}\n\n${draft.replace(/\s+$/, '')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  const d = new Date(ms);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * Classifies each line of a unified diff or a `git show` dump. Everything outside a hunk (a
 * commit's header and message, each file's `diff --git`, `index`, `---` and `+++` lines) is meta,
 * so a file header is never mistaken for an added or removed line.
 */
export function diffLines(text: string): DiffLine[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const out: DiffLine[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      inHunk = false;
      out.push({ kind: 'meta', text: line });
    } else if (line.startsWith('@@')) {
      inHunk = true;
      out.push({ kind: 'hunk', text: line });
    } else if (!inHunk) {
      out.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line });
    } else {
      out.push({ kind: 'context', text: line });
    }
  }
  return out;
}

/** Reuse a Git pane already showing the repo (docs/design.md section 4.11), else open one. */
export function routeGitRequest(
  panes: readonly { paneId: string; root: string }[],
  root: string,
): { reuse: string } | { open: true } {
  const hit = panes.find((p) => samePath(p.root, root));
  return hit ? { reuse: hit.paneId } : { open: true };
}

/** The remote Publish pushes to: `origin`, else the only remote, else null. Mirrors the core's rule. */
export function publishRemote(remotes: readonly string[]): string | null {
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0] : null;
}

export type RemoteOp = 'fetch' | 'pull' | 'push';

export interface RemoteButton {
  enabled: boolean;
  label: string;
  title: string;
}

export interface RemoteButtons {
  fetch: RemoteButton;
  pull: RemoteButton;
  push: RemoteButton;
}

const NO_REMOTE = 'This repo has no remote';

/** The branch row's Fetch, Pull, and Push / Publish buttons (docs/design.md section 4.13). */
export function remoteButtons(status: GitStatus, running: RemoteOp | null): RemoteButtons {
  const hasRemote = status.remotes.length > 0;
  const fetch: RemoteButton = {
    enabled: hasRemote,
    label: 'Fetch',
    title: hasRemote ? 'git fetch --prune' : NO_REMOTE,
  };

  const behind = status.behind > 0;
  const pull: RemoteButton = {
    enabled: status.upstream !== null && behind,
    label: behind ? `Pull (${status.behind})` : 'Pull',
    title:
      status.upstream === null
        ? 'No upstream to pull from'
        : behind
          ? 'git pull --ff-only'
          : `Up to date with ${status.upstream}`,
  };

  let push: RemoteButton;
  if (status.branch === null) {
    push = { enabled: false, label: 'Push', title: 'HEAD is detached' };
  } else if (status.upstream !== null) {
    const ahead = status.ahead > 0;
    push = { enabled: ahead, label: 'Push', title: ahead ? 'git push' : 'Nothing to push' };
  } else {
    const remote = publishRemote(status.remotes);
    if (!hasRemote) {
      push = { enabled: false, label: 'Publish', title: NO_REMOTE };
    } else if (remote === null) {
      push = {
        enabled: false,
        label: 'Publish',
        title: 'Several remotes and none named origin; publish from a terminal',
      };
    } else if (status.oid === null) {
      push = { enabled: false, label: 'Publish', title: 'No commits to publish' };
    } else {
      push = { enabled: true, label: 'Publish', title: `git push -u ${remote} ${status.branch}` };
    }
  }

  if (running !== null) {
    fetch.enabled = false;
    pull.enabled = false;
    push.enabled = false;
    if (running === 'fetch') fetch.label = 'Fetching...';
    else if (running === 'pull') pull.label = 'Pulling...';
    else push.label = push.label === 'Publish' ? 'Publishing...' : 'Pushing...';
  }
  return { fetch, pull, push };
}

/** The branch row's last fetch label; a failure carries git's output as the title. */
export function lastFetchText(
  last: GitLastFetch | null,
  now: number,
): { text: string; title: string } {
  if (last === null) return { text: '', title: '' };
  if (!last.ok) return { text: 'Fetch failed', title: last.message };
  return { text: `Fetched ${relativeTime(last.time, now)}`, title: '' };
}
