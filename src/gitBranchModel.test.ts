import { describe, expect, it } from 'vitest';
import type { GitBranchList, GitLocalBranch, GitRemoteBranch } from './gitApi';
import {
  branchNameError,
  filterBranches,
  goneBranches,
  lockedReason,
  switcherEntries,
  switcherStart,
  trackText,
  trackTitle,
} from './gitBranchModel';

function local(name: string, over: Partial<GitLocalBranch> = {}): GitLocalBranch {
  return { name, head: false, upstream: null, gone: false, ahead: 0, behind: 0, time: 0, subject: '', worktree: null, ...over };
}

function remote(name: string): GitRemoteBranch {
  const [r, ...rest] = name.split('/');
  return { name, remote: r, branch: rest.join('/'), time: 0, subject: '' };
}

const list: GitBranchList = {
  local: [local('main', { head: true }), local('UABP-45'), local('feature/old', { gone: true, upstream: 'origin/feature/old' })],
  remote: [remote('origin/release-0.3')],
};

describe('branchNameError', () => {
  it('accepts ordinary names', () => {
    for (const ok of ['main', 'UABP-45', 'feature/x-y', 'a.b', 'v1@2']) expect(branchNameError(ok), ok).toBeNull();
  });

  it('rejects what check-ref-format rejects', () => {
    const bad = ['', '-x', '@', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a..b', 'a@{1}', 'a//b', 'a/', 'a.', '/a', '.a', 'x/.y', 'a.lock', 'x/a.lock/y'];
    for (const name of bad) expect(branchNameError(name), name).not.toBeNull();
  });
});

describe('filterBranches', () => {
  it('keeps everything for a blank query', () => {
    expect(filterBranches(list, '  ')).toBe(list);
  });

  it('matches anywhere in the name, ignoring case', () => {
    expect(filterBranches(list, 'uabp').local.map((b) => b.name)).toEqual(['UABP-45']);
    expect(filterBranches(list, 'release').remote).toHaveLength(1);
  });
});

describe('trackText and trackTitle', () => {
  it('shows counts, gone, or nothing', () => {
    expect(trackText(local('a', { upstream: 'o/a', ahead: 2, behind: 1 }))).toBe('↑2 ↓1');
    expect(trackText(local('a', { upstream: 'o/a', behind: 3 }))).toBe('↓3');
    expect(trackText(local('a', { gone: true }))).toBe('gone');
    expect(trackText(local('a'))).toBe('');
  });

  it('explains the state', () => {
    expect(trackTitle(local('a'))).toBe('No upstream');
    expect(trackTitle(local('a', { upstream: 'o/a' }))).toBe('Up to date with o/a');
    expect(trackTitle(local('a', { upstream: 'o/a', gone: true }))).toBe('o/a was deleted on the remote');
  });
});

describe('lockedReason and goneBranches', () => {
  it('locks the current branch and one in another worktree', () => {
    expect(lockedReason(local('a', { head: true }))).toMatch(/current/);
    expect(lockedReason(local('a', { worktree: 'C:/r-a' }))).toBe('Checked out in C:/r-a');
    expect(lockedReason(local('a'))).toBeNull();
  });

  it('offers only unlocked gone branches', () => {
    const l: GitBranchList = {
      local: [local('cur', { head: true, gone: true }), local('wt', { gone: true, worktree: 'C:/x' }), local('old', { gone: true }), local('live')],
      remote: [],
    };
    expect(goneBranches(l).map((b) => b.name)).toEqual(['old']);
  });
});

describe('switcherEntries', () => {
  it('lists local then remote branches, with no Create row for a blank query', () => {
    expect(switcherEntries(list, '').map((e) => e.kind)).toEqual(['local', 'local', 'local', 'remote']);
  });

  it('adds a Create row for a new valid name', () => {
    expect(switcherEntries(list, 'UABP-46')).toEqual([{ kind: 'create', name: 'UABP-46' }]);
  });

  it('skips the Create row for an existing or invalid name', () => {
    expect(switcherEntries(list, 'main').some((e) => e.kind === 'create')).toBe(false);
    expect(switcherEntries(list, 'a b').some((e) => e.kind === 'create')).toBe(false);
  });

  it('keeps the Create row when the name only partly matches existing branches', () => {
    expect(switcherEntries(list, 'UABP').map((e) => e.kind)).toEqual(['local', 'create']);
  });

  it('starts on the first branch that is not current', () => {
    expect(switcherStart(switcherEntries(list, ''))).toBe(1);
    expect(switcherStart(switcherEntries(list, 'main'))).toBe(0);
    expect(switcherStart([])).toBe(-1);
  });
});
