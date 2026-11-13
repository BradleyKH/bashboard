import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from './forgeApi';
import type { PaneRun } from './paneRunModel';
import { PaneRunTracker, RUN_DEBOUNCE_MS, RUN_THROTTLE_MS, type FolderRepo, type PaneRunDeps } from './paneRunTracker';
import { FAST_POLL_MS } from './shipOverviewModel';

const T0 = Date.parse('2026-11-13T12:00:00Z');

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    number: 7,
    name: 'build',
    title: 'Push',
    branch: 'main',
    sha: null,
    event: 'push',
    status: 'running',
    rawStatus: 'in_progress',
    actor: null,
    createdAt: new Date(Date.now()).toISOString(),
    startedAt: null,
    finishedAt: null,
    webUrl: `https://example.com/runs/${id}`,
    ...over,
  };
}

interface Harness {
  tracker: PaneRunTracker;
  deps: PaneRunDeps;
  runs: { list: Run[] | Error };
  folders: Map<string, FolderRepo | null>;
  binds: [string, PaneRun | null][];
  finishes: [string, 'done' | 'failed'][];
  watch: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  forge: ReturnType<typeof vi.fn>;
  change(root: string, metadata?: boolean): void;
  setVisible(v: boolean): void;
}

function harness(): Harness {
  const runs: { list: Run[] | Error } = { list: [] };
  const folders = new Map<string, FolderRepo | null>([
    ['C:/repo', { root: 'C:/repo', branch: 'main' }],
    ['C:/repo/src', { root: 'C:/repo', branch: 'main' }],
    ['C:/other', { root: 'C:/other', branch: 'dev' }],
  ]);
  const binds: [string, PaneRun | null][] = [];
  const finishes: [string, 'done' | 'failed'][] = [];
  let changed: (root: string, metadata: boolean) => void = () => {};
  let visibility: (v: boolean) => void = () => {};
  const forge = vi.fn((_root: string, _branch: string) =>
    runs.list instanceof Error ? Promise.reject(runs.list) : Promise.resolve(runs.list.map((r) => ({ ...r }))),
  );
  const watch = vi.fn(() => Promise.resolve());
  const unwatch = vi.fn(() => Promise.resolve());
  const deps: PaneRunDeps = {
    forgeRuns: forge,
    onGitChanged: (cb) => {
      changed = cb;
    },
    gitWatch: watch,
    gitUnwatch: unwatch,
    resolve: (folder) => Promise.resolve(folders.get(folder) ?? null),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    bindVisibility: (cb) => {
      visibility = cb;
      cb(true);
    },
    bind: (id, r) => binds.push([id, r]),
    finish: (id, kind) => finishes.push([id, kind]),
  };
  return {
    tracker: new PaneRunTracker(deps),
    deps,
    runs,
    folders,
    binds,
    finishes,
    watch,
    unwatch,
    forge,
    change: (root, metadata = true) => changed(root, metadata),
    setVisible: (v) => visibility(v),
  };
}

function last<T>(list: T[]): T | undefined {
  return list[list.length - 1];
}

/** Lets resolutions and forge reads settle, advancing fake time by `ms`. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PaneRunTracker', () => {
  it('binds a new run to the most recently focused pane on the branch after a metadata change', async () => {
    const h = harness();
    h.tracker.setPanes([
      { paneId: 'p2', cwd: 'C:/repo/src' },
      { paneId: 'p1', cwd: 'C:/repo' },
    ]);
    await advance(0);
    expect(h.watch).toHaveBeenCalledTimes(1);
    expect(h.forge).not.toHaveBeenCalled();
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(h.forge).toHaveBeenCalledWith('C:/repo', 'main');
    expect(h.binds).toEqual([['p2', { name: 'build', number: 7, status: 'running', url: 'https://example.com/runs/r1' }]]);
  });

  it('ignores file-only changes and roots it does not watch', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.change('C:/repo', false);
    h.change('C:/elsewhere');
    await advance(RUN_DEBOUNCE_MS * 2);
    expect(h.forge).not.toHaveBeenCalled();
  });

  it('on a first read binds nothing for runs older than the trigger window', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('old', { createdAt: new Date(T0 - 60 * 60 * 1000).toISOString(), status: 'success' })];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(h.forge).toHaveBeenCalledTimes(1);
    expect(h.binds).toEqual([]);
  });

  it('looks once more when a push has no run yet, then stops', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(h.forge).toHaveBeenCalledTimes(1);
    h.runs.list = [run('late', { status: 'queued' })];
    await advance(RUN_THROTTLE_MS);
    expect(h.forge).toHaveBeenCalledTimes(2);
    expect(h.binds.map(([id, r]) => [id, r?.status])).toEqual([['p1', 'queued']]);
  });

  it('throttles reads per key to one per window, answering a later change at the window edge', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('r1', { status: 'success' })];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(h.forge).toHaveBeenCalledTimes(1);
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(h.forge).toHaveBeenCalledTimes(1);
    await advance(RUN_THROTTLE_MS);
    expect(h.forge).toHaveBeenCalledTimes(2);
  });

  it('polls only while a bound run is active and stops after it finishes', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(h.forge).toHaveBeenCalledTimes(1);
    await advance(FAST_POLL_MS);
    expect(h.forge).toHaveBeenCalledTimes(2);
    h.runs.list = [run('r1', { status: 'success' })];
    await advance(FAST_POLL_MS);
    expect(h.forge).toHaveBeenCalledTimes(3);
    expect(h.finishes).toEqual([['p1', 'done']]);
    expect(last(h.binds)?.[1]?.status).toBe('success');
    await advance(FAST_POLL_MS * 5);
    expect(h.forge).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['failure', [['p1', 'failed']]],
    ['cancelled', []],
  ] as const)('a run ending %s calls back %j', async (status, expected) => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    h.runs.list = [run('r1', { status })];
    await advance(FAST_POLL_MS);
    expect(h.finishes).toEqual(expected);
    expect(last(h.binds)?.[1]?.status).toBe(status);
  });

  it('a newer run replaces the bound one on the pane', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    vi.setSystemTime(Date.now() + 1000);
    h.runs.list = [run('r2'), run('r1', { status: 'failure', createdAt: new Date(T0).toISOString() })];
    await advance(FAST_POLL_MS);
    expect(last(h.binds)?.[1]?.url).toBe('https://example.com/runs/r2');
    expect(h.finishes).toEqual([]);
  });

  it('is silent on errors: nothing binds and nothing polls', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = new Error('no forge');
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    await advance(FAST_POLL_MS * 3);
    expect(h.forge).toHaveBeenCalledTimes(1);
    expect(h.binds).toEqual([]);
    expect(h.finishes).toEqual([]);
  });

  it('clears the run when the pane leaves the branch, and unwatches when the last pane leaves a root', async () => {
    const h = harness();
    h.tracker.setPanes([
      { paneId: 'p1', cwd: 'C:/repo' },
      { paneId: 'p2', cwd: 'C:/other' },
    ]);
    await advance(0);
    expect(h.watch).toHaveBeenCalledTimes(2);
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    h.tracker.setPanes([
      { paneId: 'p1', cwd: 'C:/other' },
      { paneId: 'p2', cwd: 'C:/other' },
    ]);
    expect(last(h.binds)).toEqual(['p1', null]);
    expect(h.unwatch).toHaveBeenCalledWith('C:/repo');
    expect(h.unwatch).toHaveBeenCalledTimes(1);
    await advance(FAST_POLL_MS * 2);
    expect(h.forge).toHaveBeenCalledTimes(1);
  });

  it('clears the run when a checkout moves the pane to another branch', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    h.folders.set('C:/repo', { root: 'C:/repo', branch: 'feature' });
    h.runs.list = [];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(last(h.binds)).toEqual(['p1', null]);
    expect(h.forge).toHaveBeenLastCalledWith('C:/repo', 'feature');
  });

  it('pauses polling while the window is hidden and catches up on return', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    h.setVisible(false);
    await advance(FAST_POLL_MS * 3);
    expect(h.forge).toHaveBeenCalledTimes(1);
    h.runs.list = [run('r1', { status: 'success' })];
    h.setVisible(true);
    await advance(0);
    expect(h.forge).toHaveBeenCalledTimes(2);
    expect(h.finishes).toEqual([['p1', 'done']]);
  });

  it('dispose clears timers and unwatches', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    h.tracker.dispose();
    expect(h.unwatch).toHaveBeenCalledWith('C:/repo');
    await advance(FAST_POLL_MS * 2);
    expect(h.forge).toHaveBeenCalledTimes(1);
  });

  it('stops polling a bound run that ages out of the host list', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('r1')];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(h.binds.length).toBe(1);
    h.runs.list = [];
    await advance(FAST_POLL_MS);
    const reads = h.forge.mock.calls.length;
    await advance(FAST_POLL_MS * 3);
    expect(h.forge.mock.calls.length).toBe(reads);
  });

  it('does not give back a watch it never acquired', async () => {
    const h = harness();
    h.watch.mockImplementationOnce(() => Promise.reject(new Error('no repo')));
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.tracker.setPanes([]);
    await advance(0);
    expect(h.unwatch).not.toHaveBeenCalled();
  });

  it('marks a run that had already finished when it first bound', async () => {
    const h = harness();
    h.tracker.setPanes([{ paneId: 'p1', cwd: 'C:/repo' }]);
    await advance(0);
    h.runs.list = [run('quick', { status: 'failure' })];
    h.change('C:/repo');
    await advance(RUN_DEBOUNCE_MS);
    expect(h.finishes).toEqual([['p1', 'failed']]);
  });
});
