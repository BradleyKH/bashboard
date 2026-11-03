import { describe, expect, it, vi } from 'vitest';
import type { MenuEntry, MenuItem } from './contextMenuModel';
import type { GitLocalBranch } from './gitApi';
import { localBranchMenuItems, remoteBranchMenuItems } from './gitBranchMenus';

function local(over: Partial<GitLocalBranch> = {}): GitLocalBranch {
  return { name: 'topic', head: false, upstream: null, gone: false, ahead: 0, behind: 0, time: 0, subject: '', worktree: null, ...over };
}

function items(entries: MenuEntry[]): MenuItem[] {
  return entries.filter((e): e is MenuItem => e.kind === 'item');
}

function handlers() {
  return {
    switchTo: vi.fn(),
    openWorktree: vi.fn(),
    newFrom: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    copyName: vi.fn(),
    insertName: vi.fn(),
  };
}

describe('localBranchMenuItems', () => {
  it('lists the items in order', () => {
    expect(items(localBranchMenuItems(local(), handlers())).map((i) => i.label)).toEqual([
      'Switch',
      'New branch from here',
      'Rename',
      'Delete',
      'Copy name',
      'Insert name',
    ]);
  });

  it('disables Switch and Delete on the current branch', () => {
    const entries = items(localBranchMenuItems(local({ head: true }), handlers()));
    expect(entries.find((i) => i.label === 'Switch')?.enabled).toBe(false);
    expect(entries.find((i) => i.label === 'Delete')?.enabled).toBe(false);
    expect(entries.find((i) => i.label === 'Rename')?.enabled).not.toBe(false);
  });

  it('offers the worktree instead of Switch when another worktree has the branch', () => {
    const h = handlers();
    const entries = items(localBranchMenuItems(local({ worktree: 'C:/r-topic' }), h));
    expect(entries[0].label).toBe('Open its worktree');
    entries[0].run();
    expect(h.openWorktree).toHaveBeenCalledWith('C:/r-topic');
    expect(entries.find((i) => i.label === 'Delete')?.enabled).toBe(false);
  });
});

describe('remoteBranchMenuItems', () => {
  it('checks out and copies the full remote name', () => {
    const h = { checkOut: vi.fn(), copyName: vi.fn(), insertName: vi.fn() };
    const b = { name: 'origin/x', remote: 'origin', branch: 'x', time: 0, subject: '' };
    const entries = items(remoteBranchMenuItems(b, h));
    expect(entries.map((i) => i.label)).toEqual(['Check out', 'Copy name', 'Insert name']);
    entries[0].run();
    entries[1].run();
    expect(h.checkOut).toHaveBeenCalledWith(b);
    expect(h.copyName).toHaveBeenCalledWith('origin/x');
  });
});
