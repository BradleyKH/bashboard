import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeList } from './worktreeApi';

const gitWorktrees = vi.hoisted(() => vi.fn());
vi.mock('./worktreeApi', () => ({ gitWorktrees }));
const gitWatch = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('./gitApi', () => ({
  gitWatch,
  gitUnwatch: vi.fn(() => Promise.resolve()),
}));

import { WorktreeStore } from './worktreeStore';

function list(path: string): WorktreeList {
  return {
    primary: { branch: 'main', comparison: 'main', configured: null },
    localBranches: ['main'],
    worktrees: [
      {
        path, head: 'abc', branch: 'main', detached: false, main: true, locked: false, lockReason: null,
        prunable: false, upstream: null, upstreamGone: false, ahead: 0, behind: 0, merged: 'unknown',
      },
    ],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('WorktreeStore', () => {
  beforeEach(() => {
    gitWorktrees.mockReset();
    gitWatch.mockClear();
  });

  it('ignores a git change without metadata', async () => {
    gitWorktrees.mockResolvedValue(list('C:/repo'));
    const store = new WorktreeStore(() => {});
    store.show('C:/repo');
    await flush();
    expect(gitWorktrees).toHaveBeenCalledTimes(1);
    store.handleGitChanged('C:/repo', false);
    await flush();
    expect(gitWorktrees).toHaveBeenCalledTimes(1);
    store.handleGitChanged('C:/repo', true);
    await flush();
    expect(gitWorktrees).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good list and exposes the error when a reload fails', async () => {
    gitWorktrees.mockResolvedValueOnce(list('C:/repo'));
    const store = new WorktreeStore(() => {});
    store.show('C:/repo');
    await flush();
    expect(store.current()?.list.worktrees).toHaveLength(1);

    gitWorktrees.mockRejectedValueOnce('git exploded');
    store.reload();
    await flush();
    expect(store.current()?.list.worktrees).toHaveLength(1);
    expect(store.error()).toBe('git exploded');

    gitWorktrees.mockResolvedValueOnce(list('C:/repo'));
    store.reload();
    await flush();
    expect(store.error()).toBeNull();
  });

  it('loadOnce fills peeked without showing, watching, or notifying', async () => {
    gitWorktrees.mockResolvedValue(list('C:/repo'));
    const onChange = vi.fn();
    const store = new WorktreeStore(onChange);
    await store.loadOnce('C:/repo');
    expect(store.peeked()?.list.worktrees).toHaveLength(1);
    expect(store.current()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(gitWatch).not.toHaveBeenCalled();
  });

  it('loadOnce does nothing while shown and swallows errors', async () => {
    gitWorktrees.mockResolvedValue(list('C:/repo'));
    const store = new WorktreeStore(() => {});
    store.show('C:/repo');
    await flush();
    gitWorktrees.mockClear();
    await store.loadOnce('C:/repo');
    expect(gitWorktrees).not.toHaveBeenCalled();

    const other = new WorktreeStore(() => {});
    gitWorktrees.mockRejectedValueOnce('boom');
    await other.loadOnce('C:/repo');
    expect(other.peeked()).toBeNull();
  });
});
