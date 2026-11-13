import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchSize } from './branchSizeApi';

const api = vi.hoisted(() => ({
  gitBranchSize: vi.fn(),
  repoRoot: vi.fn(),
  gitWatch: vi.fn(),
  gitUnwatch: vi.fn(),
  onGitChanged: vi.fn(),
  bindWindowVisibility: vi.fn(),
  changed: null as null | ((root: string, metadata: boolean) => void),
  visibility: null as null | ((visible: boolean) => void),
}));

vi.mock('./branchSizeApi', () => ({ gitBranchSize: api.gitBranchSize }));
vi.mock('./repoFiles', () => ({ repoRoot: api.repoRoot }));
vi.mock('./gitApi', () => ({
  gitWatch: api.gitWatch,
  gitUnwatch: api.gitUnwatch,
  onGitChanged: api.onGitChanged,
}));
vi.mock('./windowVisibility', () => ({ bindWindowVisibility: api.bindWindowVisibility }));

const { BranchSizeStore, BRANCH_SIZE_DEBOUNCE_MS } = await import('./branchSizeStore');
const { setHomeDir } = await import('./displayPath');

function sized(worktree: string, lines = 10): BranchSize {
  return { worktree, branch: 'feat', comparison: 'origin/main', lines, added: lines, removed: 0, files: 1, excludedLines: 0, excludedFiles: 0 };
}

/** Lets resolved promises settle, including the chains the store builds on them. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  api.changed = null;
  api.visibility = null;
  setHomeDir(null);
  // Every folder is its own worktree unless a test says otherwise.
  api.repoRoot.mockReset().mockImplementation(async (p: string) => ({ root: p, isGit: true }));
  api.gitBranchSize.mockReset().mockImplementation(async (p: string) => sized(p));
  api.gitWatch.mockReset().mockResolvedValue(undefined);
  api.gitUnwatch.mockReset().mockResolvedValue(undefined);
  api.onGitChanged.mockReset().mockImplementation(async (cb: (root: string, metadata: boolean) => void) => {
    api.changed = cb;
    return () => {};
  });
  api.bindWindowVisibility.mockReset().mockImplementation((cb: (visible: boolean) => void) => {
    api.visibility = cb;
    cb(true);
  });
});

afterEach(() => {
  vi.useRealTimers();
  setHomeDir(null);
});

describe('BranchSizeStore', () => {
  it('resolves a folder to its worktree, fetches, and watches it', async () => {
    api.repoRoot.mockResolvedValue({ root: 'C:/r/wt', isGit: true });
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/r/wt/src']);
    await flush();
    expect(api.gitWatch).toHaveBeenCalledWith('C:/r/wt');
    expect(api.gitBranchSize).toHaveBeenCalledWith('C:/r/wt');
    expect(store.sizeFor('C:/r/wt/src')?.worktree).toBe('C:/r/wt');
    expect(store.entryFor('C:/r/wt/src')).toMatchObject({ error: null, loading: false });
  });

  it('binds visibility and the change listener once, on first setWanted', async () => {
    const store = new BranchSizeStore();
    expect(api.bindWindowVisibility).not.toHaveBeenCalled();
    store.setWanted('a', ['C:/a']);
    store.setWanted('b', ['C:/b']);
    await flush();
    expect(api.bindWindowVisibility).toHaveBeenCalledTimes(1);
    expect(api.onGitChanged).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of git changes into one fetch', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    api.gitBranchSize.mockClear();
    api.changed?.('C:/a', false);
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS - 50);
    api.changed?.('C:/a', true);
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS - 50);
    expect(api.gitBranchSize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.gitBranchSize).toHaveBeenCalledTimes(1);
  });

  it('matches change roots by samePath and ignores unwanted roots', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/Repo/a']);
    await flush();
    api.gitBranchSize.mockClear();
    api.changed?.('c:\\repo\\a\\', true);
    api.changed?.('C:/other', true);
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS + 10);
    expect(api.gitBranchSize).toHaveBeenCalledTimes(1);
    expect(api.gitBranchSize).toHaveBeenCalledWith('C:/Repo/a');
  });

  it('keeps one fetch in flight and runs one follow-up for changes that land during it', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    api.gitBranchSize.mockClear();
    const first = deferred<BranchSize>();
    api.gitBranchSize.mockReturnValueOnce(first.promise);
    api.changed?.('C:/a', true);
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS + 10);
    expect(api.gitBranchSize).toHaveBeenCalledTimes(1);

    // Three separate changes while the first fetch is still running.
    for (let i = 0; i < 3; i++) {
      api.changed?.('C:/a', true);
      await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS + 10);
    }
    expect(api.gitBranchSize).toHaveBeenCalledTimes(1);

    first.resolve(sized('C:/a', 1));
    await flush();
    expect(api.gitBranchSize).toHaveBeenCalledTimes(2);
  });

  it('releases the watch when no key wants the worktree, and only then', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    store.setWanted('git:1', ['C:/a']);
    await flush();
    expect(api.gitWatch).toHaveBeenCalledTimes(1);

    store.setWanted('cards', []);
    await flush();
    expect(api.gitUnwatch).not.toHaveBeenCalled();

    store.setWanted('git:1', []);
    await flush();
    expect(api.gitUnwatch).toHaveBeenCalledTimes(1);
    expect(api.gitUnwatch).toHaveBeenCalledWith('C:/a');
  });

  it('releases only the worktree that dropped out of a key', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a', 'C:/b']);
    await flush();
    store.setWanted('cards', ['C:/b']);
    await flush();
    expect(api.gitUnwatch).toHaveBeenCalledTimes(1);
    expect(api.gitUnwatch).toHaveBeenCalledWith('C:/a');
  });

  it('gives back a watch that resolves after the worktree was dropped', async () => {
    const watch = deferred<void>();
    api.gitWatch.mockReturnValueOnce(watch.promise);
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    store.setWanted('cards', []);
    await flush();
    watch.resolve();
    await flush();
    expect(api.gitUnwatch).toHaveBeenCalledWith('C:/a');
  });

  it('does not refetch an unwanted worktree on change', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    store.setWanted('cards', []);
    await flush();
    api.gitBranchSize.mockClear();
    api.changed?.('C:/a', true);
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS + 10);
    expect(api.gitBranchSize).not.toHaveBeenCalled();
  });

  it('pauses while the window is hidden and catches up once on show', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    api.gitBranchSize.mockClear();
    api.visibility?.(false);
    api.changed?.('C:/a', true);
    api.changed?.('C:/a', true);
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS + 10);
    store.refresh('C:/a');
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS + 10);
    expect(api.gitBranchSize).not.toHaveBeenCalled();

    api.visibility?.(true);
    await flush();
    expect(api.gitBranchSize).toHaveBeenCalledTimes(1);
  });

  it('does not catch up on show when nothing changed while hidden', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    api.gitBranchSize.mockClear();
    api.visibility?.(false);
    api.visibility?.(true);
    await flush();
    expect(api.gitBranchSize).not.toHaveBeenCalled();
  });

  it('does not cache a failed resolution, so a later git init is picked up', async () => {
    api.repoRoot.mockResolvedValueOnce({ root: 'C:/new', isGit: false }).mockRejectedValueOnce(new Error('not a repo'));
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/new']);
    await flush();
    expect(api.gitBranchSize).not.toHaveBeenCalled();
    expect(api.gitWatch).not.toHaveBeenCalled();

    store.setWanted('cards', ['C:/new']);
    await flush();
    expect(api.gitBranchSize).not.toHaveBeenCalled();

    store.setWanted('cards', ['C:/new']);
    await flush();
    expect(api.repoRoot).toHaveBeenCalledTimes(3);
    expect(api.gitBranchSize).toHaveBeenCalledWith('C:/new');
  });

  it('caches a successful resolution', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    store.setWanted('cards', ['C:/a']);
    store.setWanted('other', ['C:/a']);
    await flush();
    expect(api.repoRoot).toHaveBeenCalledTimes(1);
    expect(api.gitWatch).toHaveBeenCalledTimes(1);
  });

  it('skips the home folder: no watch, no fetch, no size', async () => {
    setHomeDir('C:\\Users\\me');
    const store = new BranchSizeStore();
    store.setWanted('cards', ['c:/users/me/', 'C:/users/me/proj']);
    await flush();
    expect(api.gitWatch).toHaveBeenCalledTimes(1);
    expect(api.gitWatch).toHaveBeenCalledWith('C:/users/me/proj');
    expect(api.gitBranchSize).toHaveBeenCalledTimes(1);
    expect(store.sizeFor('c:/users/me/')).toBeNull();
  });

  it('refresh refetches a wanted folder after the debounce', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    api.gitBranchSize.mockClear();
    store.refresh('C:/a');
    store.refresh('C:/nowhere');
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS + 10);
    expect(api.gitBranchSize).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good size beside a later error', async () => {
    const store = new BranchSizeStore();
    store.setWanted('cards', ['C:/a']);
    await flush();
    api.gitBranchSize.mockRejectedValueOnce(new Error('index.lock'));
    store.refresh('C:/a');
    await vi.advanceTimersByTimeAsync(BRANCH_SIZE_DEBOUNCE_MS + 10);
    const entry = store.entryFor('C:/a');
    expect(entry?.size?.lines).toBe(10);
    expect(entry?.error).toContain('index.lock');
    expect(entry?.loading).toBe(false);
  });

  it('shares one worktree between folders and notifies subscribers', async () => {
    api.repoRoot.mockImplementation(async () => ({ root: 'C:/wt', isGit: true }));
    const store = new BranchSizeStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.setWanted('cards', ['C:/wt/a', 'C:/wt/b']);
    await flush();
    expect(api.gitWatch).toHaveBeenCalledTimes(1);
    expect(api.gitBranchSize).toHaveBeenCalledTimes(1);
    expect(store.sizeFor('C:/wt/a')).toBe(store.sizeFor('C:/wt/b'));
    expect(cb).toHaveBeenCalled();
  });

  describe('threshold', () => {
    it('defaults to 400 and notifies only when it changes', () => {
      const store = new BranchSizeStore();
      const cb = vi.fn();
      store.subscribe(cb);
      expect(store.threshold()).toBe(400);
      store.applySettings({ git: { autoFetchMinutes: 5, branchSizeThreshold: 400 } });
      expect(cb).not.toHaveBeenCalled();
      store.applySettings({ git: { autoFetchMinutes: 5, branchSizeThreshold: 250 } });
      expect(store.threshold()).toBe(250);
      expect(cb).toHaveBeenCalledTimes(1);
      store.applySettings({ git: { autoFetchMinutes: 5, branchSizeThreshold: 0 } });
      expect(store.threshold()).toBe(0);
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });
});
