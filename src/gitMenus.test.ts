import { describe, expect, it, vi } from 'vitest';
import type { MenuEntry, MenuItem } from './contextMenuModel';
import type { GitCommit } from './gitApi';
import { gitCommitMenuItems, gitFileMenuItems, type GitCommitMenuState } from './gitMenus';
import type { GitRow } from './gitModel';

function row(status: string, path = 'src/a.ts'): GitRow {
  return { key: `unstaged:${path}`, kind: 'unstaged', entry: { path, status } as GitRow['entry'] };
}

function commit(hash: string): GitCommit {
  return { hash, subject: 'Fix thing', author: 'me', time: 0, pushed: false };
}

function items(entries: MenuEntry[]): MenuItem[] {
  return entries.filter((e): e is MenuItem => e.kind === 'item');
}

function byLabel(entries: MenuEntry[], label: string): MenuItem {
  const found = items(entries).find((i) => i.label === label);
  if (!found) throw new Error(`no item ${label}`);
  return found;
}

function fileHandlers() {
  return {
    showDiff: vi.fn(),
    toggle: vi.fn(),
    openInEditor: vi.fn(),
    copyPath: vi.fn(),
    insertPath: vi.fn(),
  };
}

describe('gitFileMenuItems', () => {
  it('lists the items in order', () => {
    const labels = items(gitFileMenuItems(row('M'), false, fileHandlers())).map((i) => i.label);
    expect(labels).toEqual(['Show diff', 'Stage', 'Open in editor', 'Copy path', 'Insert path']);
  });

  it('offers Unstage in the Staged list', () => {
    const labels = items(gitFileMenuItems(row('M'), true, fileHandlers())).map((i) => i.label);
    expect(labels).toContain('Unstage');
    expect(labels).not.toContain('Stage');
  });

  it('disables Open in editor for a deleted file but keeps the path items enabled', () => {
    const entries = gitFileMenuItems(row('D'), false, fileHandlers());
    expect(byLabel(entries, 'Open in editor').enabled).toBe(false);
    expect(byLabel(entries, 'Copy path').enabled).not.toBe(false);
    expect(byLabel(entries, 'Insert path').enabled).not.toBe(false);
  });

  it('passes the row to each handler', () => {
    const h = fileHandlers();
    const r = row('M');
    const entries = gitFileMenuItems(r, false, h);
    for (const label of ['Show diff', 'Stage', 'Open in editor', 'Copy path', 'Insert path']) {
      byLabel(entries, label).run();
    }
    expect(h.showDiff).toHaveBeenCalledWith(r);
    expect(h.toggle).toHaveBeenCalledWith(r);
    expect(h.openInEditor).toHaveBeenCalledWith(r);
    expect(h.copyPath).toHaveBeenCalledWith(r);
    expect(h.insertPath).toHaveBeenCalledWith(r);
  });
});

describe('gitCommitMenuItems', () => {
  const commitHandlers = () => ({ showDiff: vi.fn(), copyHash: vi.fn(), copySubject: vi.fn(), undo: vi.fn(), push: vi.fn() });
  const state = (over: Partial<GitCommitMenuState> = {}): GitCommitMenuState => ({
    undoHash: null,
    push: null,
    canPush: true,
    ...over,
  });

  it('offers Undo commit only for the undo target', () => {
    const c = commit('abc123');
    const labels = (undoHash: string | null) =>
      items(gitCommitMenuItems(c, state({ undoHash }), commitHandlers())).map((i) => i.label);
    expect(labels('abc123')).toEqual(['Show diff', 'Copy hash', 'Copy subject', 'Undo commit']);
    expect(labels('def456')).toEqual(['Show diff', 'Copy hash', 'Copy subject']);
    expect(labels(null)).toEqual(['Show diff', 'Copy hash', 'Copy subject']);
  });

  it('offers Push on HEAD and Push up to here on an older unpushed commit', () => {
    const c = commit('abc123');
    const labels = (s: GitCommitMenuState) => items(gitCommitMenuItems(c, s, commitHandlers())).map((i) => i.label);
    expect(labels(state({ push: 'push', undoHash: 'abc123' }))).toEqual([
      'Show diff',
      'Copy hash',
      'Copy subject',
      'Push',
      'Undo commit',
    ]);
    expect(labels(state({ push: 'upTo' }))).toEqual(['Show diff', 'Copy hash', 'Copy subject', 'Push up to here']);
  });

  it('disables the push entry while a remote operation runs', () => {
    const entries = gitCommitMenuItems(commit('abc123'), state({ push: 'upTo', canPush: false }), commitHandlers());
    expect(byLabel(entries, 'Push up to here').enabled).toBe(false);
  });

  it('passes the commit, full hash, and subject to the handlers', () => {
    const h = commitHandlers();
    const c = commit('abc123def');
    const entries = gitCommitMenuItems(c, state({ undoHash: 'abc123def', push: 'push' }), h);
    for (const label of ['Show diff', 'Copy hash', 'Copy subject', 'Undo commit', 'Push']) {
      byLabel(entries, label).run();
    }
    expect(h.showDiff).toHaveBeenCalledWith(c);
    expect(h.copyHash).toHaveBeenCalledWith('abc123def');
    expect(h.copySubject).toHaveBeenCalledWith('Fix thing');
    expect(h.undo).toHaveBeenCalledWith('abc123def');
    expect(h.push).toHaveBeenCalledWith(null);

    const older = gitCommitMenuItems(c, state({ push: 'upTo' }), h);
    byLabel(older, 'Push up to here').run();
    expect(h.push).toHaveBeenCalledWith('abc123def');
  });
});
