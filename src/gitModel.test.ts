import { describe, expect, it } from 'vitest';
import type { GitCommit, GitLastFetch, GitStatus } from './gitApi';
import {
  branchLine,
  canCommit,
  changesList,
  diffLines,
  lastFetchText,
  mergeUndoMessage,
  publishRemote,
  relativeTime,
  remoteButtons,
  routeGitRequest,
  shortHash,
  stagedList,
  undoTarget,
} from './gitModel';

const OID = 'a'.repeat(40);

function status(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    oid: OID,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    remotes: [],
    ...over,
  };
}

function commit(over: Partial<GitCommit> = {}): GitCommit {
  return { hash: OID, subject: 's', author: 'a', time: 0, pushed: false, ...over };
}

describe('branchLine', () => {
  it('shows the upstream with counts', () => {
    expect(branchLine(status({ upstream: 'origin/main', ahead: 2, behind: 1 }))).toBe(
      'main -> origin/main, 2 ahead, 1 behind',
    );
  });
  it('says up to date when level with the upstream', () => {
    expect(branchLine(status({ upstream: 'origin/main' }))).toBe('main -> origin/main, up to date');
  });
  it('notes a missing upstream', () => {
    expect(branchLine(status())).toBe('main (no upstream)');
  });
  it('reads a detached HEAD by its short hash', () => {
    expect(branchLine(status({ branch: null }))).toBe('detached at aaaaaaa');
  });
  it('reads an unborn repo', () => {
    expect(branchLine(status({ oid: null }))).toBe('main (no upstream)');
    expect(branchLine(status({ branch: null, oid: null }))).toBe('detached HEAD');
  });
});

describe('changesList', () => {
  it('merges unstaged, untracked, and conflicted sorted by path', () => {
    const rows = changesList(
      status({
        unstaged: [{ path: 'b.ts', status: 'M' }],
        untracked: [{ path: 'a.ts', status: '?' }],
        conflicted: [{ path: 'c.ts', status: 'U' }],
      }),
    );
    expect(rows.map((r) => r.key)).toEqual(['untracked:a.ts', 'unstaged:b.ts', 'conflicted:c.ts']);
  });
  it('keeps a file in both lists as two distinct rows', () => {
    const s = status({
      staged: [{ path: 'a.ts', status: 'M' }],
      unstaged: [{ path: 'a.ts', status: 'M' }],
    });
    const keys = [...stagedList(s), ...changesList(s)].map((r) => r.key);
    expect(keys).toEqual(['staged:a.ts', 'unstaged:a.ts']);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('canCommit', () => {
  const staged = status({ staged: [{ path: 'a', status: 'A' }] });
  it('needs something staged and a message', () => {
    expect(canCommit(staged, 'msg')).toBe(true);
    expect(canCommit(status(), 'msg')).toBe(false);
    expect(canCommit(staged, '  \n ')).toBe(false);
  });
});

describe('undoTarget', () => {
  it('returns the newest commit that is HEAD', () => {
    const c = commit();
    expect(undoTarget([c, commit({ hash: 'b' })], status())).toBe(c);
  });
  it('returns the newest commit even when it is pushed', () => {
    const c = commit({ pushed: true });
    expect(undoTarget([c], status())).toBe(c);
  });
  it('is null when HEAD differs or the repo is unborn', () => {
    expect(undoTarget([commit({ hash: 'b' })], status())).toBeNull();
    expect(undoTarget([], status({ oid: null }))).toBeNull();
  });
});

describe('mergeUndoMessage', () => {
  it('uses the undone message when there is no draft', () => {
    expect(mergeUndoMessage('Fix it\n', '  ')).toBe('Fix it');
  });
  it('keeps a draft below the undone message', () => {
    expect(mergeUndoMessage('Fix it\n', 'Also this\n')).toBe('Fix it\n\nAlso this');
  });
  it('does not repeat a draft that matches the message', () => {
    expect(mergeUndoMessage('Fix it\n', 'Fix it')).toBe('Fix it');
  });
});

describe('relativeTime', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  it('buckets by age', () => {
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 d ago');
  });
  it('falls back to a short date, with the year when it differs', () => {
    expect(relativeTime(new Date(2026, 2, 4).getTime(), now)).toBe('Mar 4');
    expect(relativeTime(new Date(2025, 2, 4).getTime(), now)).toBe('Mar 4, 2025');
  });
});

describe('shortHash', () => {
  it('keeps 7 characters', () => {
    expect(shortHash(OID)).toBe('aaaaaaa');
  });
});

describe('diffLines', () => {
  it('classifies file headers as meta, not add or del', () => {
    const text = [
      'diff --git a/x b/x',
      'index 1..2 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '',
    ].join('\n');
    expect(diffLines(text).map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'del',
      'add',
    ]);
  });
  it('treats a removed line starting with dashes inside a hunk as del', () => {
    const lines = diffLines('@@ -1 +1 @@\n--- old\n+++ new\n');
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'add']);
  });
  it('treats a commit header and message as meta and resets per file', () => {
    const text = [
      'commit abc',
      'Author:     A <a@b>',
      '',
      '    subject',
      '',
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/y b/y',
      '--- a/y',
      '+++ b/y',
      '@@ -1 +1 @@',
      '+c',
    ].join('\n');
    const kinds = diffLines(text).map((l) => l.kind);
    expect(kinds.slice(0, 5)).toEqual(['meta', 'meta', 'meta', 'meta', 'meta']);
    expect(kinds.slice(11, 15)).toEqual(['meta', 'meta', 'meta', 'hunk']);
  });
  it('returns nothing for empty text and keeps the line text', () => {
    expect(diffLines('')).toEqual([]);
    expect(diffLines('@@ x @@\n+a\n')).toEqual([
      { kind: 'hunk', text: '@@ x @@' },
      { kind: 'add', text: '+a' },
    ]);
  });
});

describe('routeGitRequest', () => {
  const panes = [{ paneId: 'v1', root: 'C:\\Repos\\App' }];
  it('reuses a pane whose root differs only in case or slash style', () => {
    expect(routeGitRequest(panes, 'c:/repos/app/')).toEqual({ reuse: 'v1' });
  });
  it('opens a new pane for a different repo or none', () => {
    expect(routeGitRequest(panes, 'C:\\Repos\\Other')).toEqual({ open: true });
    expect(routeGitRequest([], 'C:\\Repos\\App')).toEqual({ open: true });
  });
});

describe('publishRemote', () => {
  it('prefers origin, else the only remote, else null', () => {
    expect(publishRemote([])).toBeNull();
    expect(publishRemote(['fork', 'origin'])).toBe('origin');
    expect(publishRemote(['fork'])).toBe('fork');
    expect(publishRemote(['a', 'b'])).toBeNull();
  });
});

describe('remoteButtons', () => {
  const tracked = { remotes: ['origin'], upstream: 'origin/main' };

  it('disables Fetch and Publish without a remote', () => {
    const b = remoteButtons(status(), null);
    expect(b.fetch).toEqual({ enabled: false, label: 'Fetch', title: 'This repo has no remote' });
    expect(b.push).toEqual({ enabled: false, label: 'Publish', title: 'This repo has no remote' });
    expect(b.pull).toEqual({ enabled: false, label: 'Pull', title: 'No upstream to pull from' });
  });
  it('enables Pull with the count while behind', () => {
    const b = remoteButtons(status({ ...tracked, behind: 3 }), null);
    expect(b.fetch).toEqual({ enabled: true, label: 'Fetch', title: 'git fetch --prune' });
    expect(b.pull).toEqual({ enabled: true, label: 'Pull (3)', title: 'git pull --ff-only' });
    expect(b.push).toEqual({ enabled: false, label: 'Push', title: 'Nothing to push' });
  });
  it('disables Pull and Push when up to date', () => {
    const b = remoteButtons(status(tracked), null);
    expect(b.pull).toEqual({ enabled: false, label: 'Pull', title: 'Up to date with origin/main' });
    expect(b.push.enabled).toBe(false);
  });
  it('enables Push while ahead', () => {
    const b = remoteButtons(status({ ...tracked, ahead: 2 }), null);
    expect(b.push).toEqual({ enabled: true, label: 'Push', title: 'git push' });
  });
  it('publishes an unpublished branch to origin', () => {
    const b = remoteButtons(status({ remotes: ['origin'] }), null);
    expect(b.push).toEqual({ enabled: true, label: 'Publish', title: 'git push -u origin main' });
  });
  it('publishes to the only remote when it is not origin', () => {
    const b = remoteButtons(status({ remotes: ['fork'] }), null);
    expect(b.push).toEqual({ enabled: true, label: 'Publish', title: 'git push -u fork main' });
  });
  it('disables Publish with several remotes and no origin', () => {
    const b = remoteButtons(status({ remotes: ['a', 'b'] }), null);
    expect(b.push).toEqual({
      enabled: false,
      label: 'Publish',
      title: 'Several remotes and none named origin; publish from a terminal',
    });
  });
  it('disables Push on a detached HEAD', () => {
    const b = remoteButtons(status({ branch: null, remotes: ['origin'] }), null);
    expect(b.push).toEqual({ enabled: false, label: 'Push', title: 'HEAD is detached' });
  });
  it('disables Publish with no commits', () => {
    const b = remoteButtons(status({ oid: null, remotes: ['origin'] }), null);
    expect(b.push).toEqual({ enabled: false, label: 'Publish', title: 'No commits to publish' });
  });
  it('disables everything while an operation runs and relabels it', () => {
    const s = status({ ...tracked, behind: 1, ahead: 1 });
    const none = (r: ReturnType<typeof remoteButtons>) => [r.fetch, r.pull, r.push].every((x) => !x.enabled);
    const f = remoteButtons(s, 'fetch');
    expect(none(f)).toBe(true);
    expect(f.fetch.label).toBe('Fetching...');
    const pl = remoteButtons(s, 'pull');
    expect(none(pl)).toBe(true);
    expect(pl.pull.label).toBe('Pulling...');
    const ps = remoteButtons(s, 'push');
    expect(none(ps)).toBe(true);
    expect(ps.push.label).toBe('Pushing...');
    expect(remoteButtons(status({ remotes: ['origin'] }), 'push').push.label).toBe('Publishing...');
  });
});

describe('lastFetchText', () => {
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const ok = (ago: number): GitLastFetch => ({ time: now - ago, ok: true, message: '' });
  it('is empty before any fetch', () => {
    expect(lastFetchText(null, now)).toEqual({ text: '', title: '' });
  });
  it('reads the age of a successful fetch', () => {
    expect(lastFetchText(ok(5_000), now)).toEqual({ text: 'Fetched just now', title: '' });
    expect(lastFetchText(ok(3 * 60_000), now)).toEqual({ text: 'Fetched 3 min ago', title: '' });
    expect(lastFetchText(ok(2 * 3_600_000), now).text).toBe('Fetched 2 h ago');
  });
  it('reports a failure with git output as the title', () => {
    const last: GitLastFetch = { time: now, ok: false, message: 'fatal: no route' };
    expect(lastFetchText(last, now)).toEqual({ text: 'Fetch failed', title: 'fatal: no route' });
  });
});
