import { describe, expect, it } from 'vitest';
import type { GitCommit, GitStatus } from './gitApi';
import {
  branchLine,
  canCommit,
  changesList,
  diffLines,
  mergeUndoMessage,
  relativeTime,
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
