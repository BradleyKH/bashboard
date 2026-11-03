import { describe, expect, it } from 'vitest';
import type { OtherCardInput, PaneCardInput, TerminalCardInput } from './dashboardModel';
import type { Session } from './sessions';
import type { Worktree } from './worktreeApi';
import {
  compareLabel,
  countsText,
  deleteBranchChoice,
  filterWorktrees,
  isRepoRoot,
  mergedText,
  removalBlockers,
  sameOrInside,
  upstreamText,
  workingTreeText,
  worktreeBadge,
} from './worktreeModel';

function wt(over: Partial<Worktree> = {}): Worktree {
  return {
    path: 'C:\\src\\app',
    head: 'abc1234',
    branch: 'feature',
    detached: false,
    main: false,
    locked: false,
    lockReason: null,
    prunable: false,
    upstream: null,
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    merged: 'notMerged',
    ...over,
  };
}

function terminal(cwd: string | null): TerminalCardInput {
  return {
    kind: 'terminal',
    paneId: 't1',
    tabId: 'tab',
    ptyId: 1,
    cwd,
    profile: 'bash',
    focused: false,
    openedAt: 0,
    collapsed: false,
    shell: { state: 'idle' } as unknown as TerminalCardInput['shell'],
    attention: false,
    mark: null,
  };
}

function files(folder: string | null, root?: string): OtherCardInput {
  return {
    kind: 'files',
    paneId: 'f1',
    tabId: 'tab',
    title: 'Files (wt)',
    folder,
    root,
    focused: false,
    collapsed: false,
    openedAt: 0,
    confirmClose: false,
  } as OtherCardInput;
}

function session(cwd: string): Session {
  return { sessionId: 's', pid: 1, name: null, cwd, status: 'idle', statusChangedAt: 0, startedAt: 0, version: null, paneId: null } as unknown as Session;
}

describe('worktreeBadge', () => {
  it('shows Merged ahead of Locked and Prunable', () => {
    expect(worktreeBadge(wt({ merged: 'merged', locked: true, prunable: true }))).toBe('Merged');
  });
  it('shows Probably merged ahead of Locked', () => {
    expect(worktreeBadge(wt({ merged: 'probablyMerged', locked: true }))).toBe('Probably merged');
  });
  it('shows Locked ahead of Prunable', () => {
    expect(worktreeBadge(wt({ locked: true, prunable: true }))).toBe('Locked');
    expect(worktreeBadge(wt({ prunable: true }))).toBe('Prunable');
  });
  it('never shows a merged badge on the main worktree', () => {
    expect(worktreeBadge(wt({ main: true, merged: 'merged' }))).toBeNull();
    expect(worktreeBadge(wt({ main: true, merged: 'merged', locked: true }))).toBe('Locked');
  });
  it('shows nothing for a plain worktree', () => {
    expect(worktreeBadge(wt())).toBeNull();
  });
});

describe('countsText', () => {
  it('covers each zero case', () => {
    expect(countsText(3, 12)).toBe('3 ahead, 12 behind');
    expect(countsText(3, 0)).toBe('3 ahead');
    expect(countsText(0, 12)).toBe('12 behind');
    expect(countsText(0, 0)).toBe('');
  });
});

describe('mergedText', () => {
  it('words each state', () => {
    expect(mergedText('merged', 'origin/main', null)).toBe('Merged: every commit is in origin/main');
    expect(mergedText('probablyMerged', 'origin/main', 'origin/feature-x')).toBe(
      'Probably merged: origin/feature-x was deleted on the remote',
    );
    expect(mergedText('notMerged', 'origin/main', null)).toBe('Not merged');
    expect(mergedText('unknown', null, null)).toBe('No primary branch to compare with');
  });
});

describe('upstreamText', () => {
  const base = { upstream: null, upstreamGone: false, upstreamAhead: 0, upstreamBehind: 0 };
  it('words the upstream states', () => {
    expect(upstreamText(base)).toBe('No upstream');
    expect(upstreamText({ ...base, upstream: 'origin/x' })).toBe('origin/x');
    expect(upstreamText({ ...base, upstream: 'origin/x', upstreamAhead: 1, upstreamBehind: 2 })).toBe(
      'origin/x 1 ahead, 2 behind',
    );
    expect(upstreamText({ ...base, upstream: 'origin/x', upstreamGone: true })).toBe(
      'Upstream deleted on the remote',
    );
  });
});

describe('workingTreeText', () => {
  it('says Clean or lists the non-zero parts', () => {
    expect(workingTreeText({ staged: 0, changed: 0, untracked: 0 })).toBe('Clean');
    expect(workingTreeText({ staged: 2, changed: 3, untracked: 1 })).toBe(
      '2 staged, 3 changed, 1 untracked',
    );
    expect(workingTreeText({ staged: 0, changed: 3, untracked: 0 })).toBe('3 changed');
  });
});

describe('sameOrInside', () => {
  it('matches equal and nested paths regardless of case, slashes, and trailing separators', () => {
    expect(sameOrInside('C:\\a\\b', 'c:/A/B/')).toBe(true);
    expect(sameOrInside('C:\\a\\b\\c\\d', 'C:\\a\\b')).toBe(true);
  });
  it('respects the folder boundary', () => {
    expect(sameOrInside('C:\\a\\bc', 'C:\\a\\b')).toBe(false);
    expect(sameOrInside('C:\\a', 'C:\\a\\b')).toBe(false);
  });
});

describe('removalBlockers', () => {
  const path = 'C:\\src\\wt';
  it('names a terminal inside the folder', () => {
    expect(removalBlockers(path, [terminal('C:\\src\\wt\\sub')], [])).toBe(
      'Close these panes first: terminal in sub',
    );
  });
  it('uses root for a non-terminal pane and lists several', () => {
    const msg = removalBlockers(path, [files('D:\\elsewhere', 'C:\\src\\wt'), terminal(path)], []);
    expect(msg).toBe('Close these panes first: Files (wt), terminal in wt');
  });
  it('names an external session inside the folder', () => {
    expect(removalBlockers(path, [], [session('C:\\src\\wt\\x')])).toBe(
      'An external Claude session is working in this folder',
    );
  });
  it('returns null when nothing is inside', () => {
    const panes: PaneCardInput[] = [terminal('C:\\src\\wtx'), files('C:\\src\\other')];
    expect(removalBlockers(path, panes, [session('C:\\src\\wtx')])).toBeNull();
  });
});

describe('deleteBranchChoice', () => {
  it('hides for a detached worktree', () => {
    expect(deleteBranchChoice(wt({ branch: null, detached: true, merged: 'merged' })).show).toBe(false);
  });
  it('checks and enables for Merged', () => {
    expect(deleteBranchChoice(wt({ merged: 'merged' }))).toEqual({ show: true, checked: true, enabled: true });
  });
  it('disables with a note for Probably merged', () => {
    const c = deleteBranchChoice(wt({ merged: 'probablyMerged' }));
    expect(c).toMatchObject({ show: true, checked: false, enabled: false });
    expect(c.note).toContain('git branch -D');
  });
  it('disables for Not merged and unknown', () => {
    expect(deleteBranchChoice(wt({ merged: 'notMerged' }))).toEqual({ show: true, checked: false, enabled: false });
    expect(deleteBranchChoice(wt({ merged: 'unknown' }))).toEqual({ show: true, checked: false, enabled: false });
  });
});

describe('isRepoRoot', () => {
  it('matches a listed worktree path loosely', () => {
    const list = [wt({ path: 'C:\\src\\app' }), wt({ path: 'C:\\src\\wt' })];
    expect(isRepoRoot('c:/src/WT/', list)).toBe(true);
    expect(isRepoRoot('C:\\src\\w', list)).toBe(false);
  });
});

describe('filterWorktrees', () => {
  const list = [
    wt({ path: 'C:/src/app', branch: 'main' }),
    wt({ path: 'C:/src/app-fix', branch: 'Bug-42' }),
    wt({ path: 'C:/src/scratch', branch: null }),
  ];
  it('keeps every worktree for a blank query', () => {
    expect(filterWorktrees(list, '  ')).toBe(list);
  });
  it('matches the folder name or the branch, ignoring case', () => {
    expect(filterWorktrees(list, 'FIX').map((w) => w.path)).toEqual(['C:/src/app-fix']);
    expect(filterWorktrees(list, 'bug').map((w) => w.path)).toEqual(['C:/src/app-fix']);
    expect(filterWorktrees(list, 'src')).toEqual([]);
  });
});

describe('compareLabel', () => {
  it('names the configured branch, then the automatic one, then nothing', () => {
    expect(compareLabel({ branch: 'dev', comparison: 'origin/dev', configured: 'dev' })).toBe('Compare with dev');
    expect(compareLabel({ branch: 'main', comparison: 'origin/main', configured: null })).toBe('Compare with main (auto)');
    expect(compareLabel({ branch: null, comparison: null, configured: null })).toBe('Compare with...');
  });
});
