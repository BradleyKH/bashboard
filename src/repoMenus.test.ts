import { describe, expect, it, vi } from 'vitest';
import { item, type MenuEntry, type MenuItem } from './contextMenuModel';
import { pinRowMenuItems, worktreeRowMenuItems } from './repoMenus';

const items = (entries: MenuEntry[]) => entries.filter((e): e is MenuItem => e.kind === 'item');
const enabledLabels = (entries: MenuEntry[]) => items(entries).filter((i) => i.enabled !== false).map((i) => i.label);

const pinHandlers = () => ({
  open: vi.fn(),
  openInExplorer: vi.fn(),
  copyPath: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
});

describe('pinRowMenuItems', () => {
  it('enables everything for an existing pin', () => {
    expect(enabledLabels(pinRowMenuItems({ exists: true }, pinHandlers()))).toEqual([
      'Open',
      'Open in File Explorer',
      'Copy path',
      'Rename',
      'Remove pin',
    ]);
  });

  it('leaves only Remove pin for a missing pin', () => {
    expect(enabledLabels(pinRowMenuItems({ exists: false }, pinHandlers()))).toEqual(['Remove pin']);
  });

  it('runs each handler', () => {
    const h = pinHandlers();
    items(pinRowMenuItems({ exists: true }, h)).forEach((i) => i.run());
    for (const fn of Object.values(h)) expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('worktreeRowMenuItems', () => {
  const open = () => [item('Terminal', vi.fn()), item('Files', vi.fn())];
  const handlers = () => ({ openInExplorer: vi.fn(), copyPath: vi.fn(), delete: vi.fn() });

  it('enables everything for a present worktree', () => {
    expect(enabledLabels(worktreeRowMenuItems({ missing: false }, open(), handlers()))).toEqual([
      'Terminal',
      'Files',
      'Open in File Explorer',
      'Copy path',
      'Delete',
    ]);
  });

  it('leaves only Delete for a missing worktree', () => {
    expect(enabledLabels(worktreeRowMenuItems({ missing: true }, open(), handlers()))).toEqual(['Delete']);
  });

  it('omits Delete without a delete handler and disables it when locked', () => {
    const { delete: _d, ...noDelete } = handlers();
    expect(items(worktreeRowMenuItems({ missing: false }, open(), noDelete)).map((i) => i.label)).not.toContain('Delete');
    expect(enabledLabels(worktreeRowMenuItems({ missing: false, locked: true }, open(), handlers()))).not.toContain('Delete');
  });

  it('runs the handlers', () => {
    const h = handlers();
    items(worktreeRowMenuItems({ missing: false }, open(), h)).forEach((i) => i.run());
    expect(h.openInExplorer).toHaveBeenCalledTimes(1);
    expect(h.copyPath).toHaveBeenCalledTimes(1);
    expect(h.delete).toHaveBeenCalledTimes(1);
  });
});
