import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeRepo, OverviewRepo, PinnedRepo, PullRequest, Run, RunStatus } from './forgeApi';

const api = vi.hoisted(() => ({
  forgeOverviewRepo: vi.fn(),
  forgePullChecks: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock('./forgeApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./forgeApi')>()),
  forgeOverviewRepo: api.forgeOverviewRepo,
  forgePullChecks: api.forgePullChecks,
}));
vi.mock('./settings', () => ({ saveSetting: api.saveSetting }));

const { ForgeOverviewStore } = await import('./forgeOverviewStore');
type Settings = import('./settings').Settings;

const REPO = { host: 'github.com', owner: 'acme', name: 'api' } as ForgeRepo;

function run(branch: string, status: RunStatus): Run {
  return {
    id: `${branch}-${status}`,
    number: 1,
    name: 'CI',
    title: 't',
    branch,
    sha: null,
    event: null,
    status,
    rawStatus: status,
    actor: null,
    createdAt: '2026-11-01T00:00:00Z',
    startedAt: null,
    finishedAt: null,
    webUrl: '',
  };
}

function pull(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p1',
    number: 1,
    title: 'p',
    author: 'a',
    draft: false,
    state: 'open',
    sourceBranch: 'feat',
    targetBranch: 'main',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    webUrl: '',
    reviewDecision: null,
    reviewers: [],
    checks: null,
    checksPending: false,
    isMine: false,
    reviewRequested: false,
    ...over,
  };
}

function overview(runs: Run[] = [], pulls: PullRequest[] = []): OverviewRepo {
  return { repo: REPO, defaultBranch: 'main', runs, pulls: { items: pulls, total: null } };
}

function settings(pinnedRepos: PinnedRepo[], overviewRefreshMinutes = 5): Settings {
  return { forge: { hosts: {}, pinnedRepos, overviewRefreshMinutes } } as unknown as Settings;
}

const calls = () => api.forgeOverviewRepo.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  vi.useFakeTimers();
  api.forgeOverviewRepo.mockReset().mockResolvedValue(overview([run('main', 'success')]));
  api.forgePullChecks.mockReset().mockResolvedValue([]);
  api.saveSetting.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ForgeOverviewStore', () => {
  it('does not poll until wanted, then staggers the first round', async () => {
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }, { repo: 'b' }, { repo: 'c', root: 'C:/c' }]));
    expect(calls()).toEqual([]);
    store.setWanted('pane', true);
    expect(calls()).toEqual(['remote:a']);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls()).toEqual(['remote:a', 'remote:b']);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls()).toEqual(['remote:a', 'remote:b', 'C:/c']);
    expect(store.rows().every((r) => r.row !== null && !r.loading)).toBe(true);
    expect(store.lastUpdated()).not.toBeNull();
  });

  it('polls on the heartbeat, and every minute while a watched branch runs', async () => {
    api.forgeOverviewRepo.mockResolvedValue(overview([run('main', 'running')]));
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }], 5));
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toHaveLength(2);
    api.forgeOverviewRepo.mockResolvedValue(overview([run('main', 'success')]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(calls()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toHaveLength(4);
  });

  it('moves to the fast cadence when a branches-only edit watches a running branch', async () => {
    api.forgeOverviewRepo.mockResolvedValue(overview([run('main', 'success'), run('dev', 'running')]));
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }], 5));
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toHaveLength(1);
    store.applySettings(settings([{ repo: 'a', branches: ['dev'] }], 5));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toHaveLength(2);
  });

  it('pauses while unwanted and catches up on what fell due when wanted again', async () => {
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }], 5));
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(0);
    store.setWanted('pane', false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls()).toHaveLength(1);
    store.setWanted('dash', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toHaveLength(2);
    // Not yet due again, so a quick toggle does not poll.
    store.setWanted('dash', false);
    store.setWanted('dash', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toHaveLength(2);
  });

  it('polls only on demand when the heartbeat is 0 and nothing runs', async () => {
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }], 0));
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls()).toHaveLength(1);
    await store.refresh();
    expect(calls()).toHaveLength(2);
  });

  it('holds Bitbucket pins to the request budget, leaving other hosts alone', async () => {
    api.forgeOverviewRepo.mockResolvedValue(overview([run('main', 'running')]));
    const bb = Array.from({ length: 10 }, (_, i) => ({ repo: `bitbucket.org/k/r${i}` }));
    const store = new ForgeOverviewStore();
    store.applySettings(settings([...bb, { repo: 'github.com/acme/api' }], 5));
    expect(store.bitbucketSlowedMs()).toBe(180_000);
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(5_000);
    const count = (prefix: string) => calls().filter((c) => c.startsWith(`remote:${prefix}`)).length;
    expect([count('bitbucket'), count('github')]).toEqual([10, 1]);
    await vi.advanceTimersByTimeAsync(170_000);
    expect([count('bitbucket'), count('github')]).toEqual([10, 3]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count('bitbucket')).toBe(20);

    // Unpinning down to three lifts the slowdown and retimes the pins already waiting.
    store.applySettings(settings(bb.slice(0, 3), 5));
    expect(store.bitbucketSlowedMs()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count('bitbucket')).toBe(23);
  });

  it('reconciles pins on a settings change', async () => {
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }, { repo: 'b' }], 5));
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls()).toEqual(['remote:a', 'remote:b']);

    store.applySettings(settings([{ repo: 'a', root: 'C:/a' }, { repo: 'c' }], 5));
    await vi.advanceTimersByTimeAsync(0);
    // A changed root and a new pin poll at once; the removed pin drops.
    expect(calls().slice(2).sort()).toEqual(['C:/a', 'remote:c']);
    expect(store.rows().map((r) => r.pin.repo).sort()).toEqual(['a', 'c']);
    expect(store.isPinned('b')).toBe(false);

    store.applySettings(settings([{ repo: 'a', root: 'C:/a', branches: ['uat'] }, { repo: 'c' }], 5));
    expect(calls()).toHaveLength(4);
    const a = store.rows().find((r) => r.pin.repo === 'a');
    expect(a?.row?.health.map((h) => h.branch)).toEqual(['main', 'uat']);
  });

  it('drops a reply for a target that changed while it was in flight, then asks again', async () => {
    let resolveFirst: (o: OverviewRepo) => void = () => {};
    api.forgeOverviewRepo.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }], 5));
    store.setWanted('pane', true);
    store.applySettings(settings([{ repo: 'a', root: 'C:/a' }], 5));
    resolveFirst(overview([run('main', 'failure')]));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toEqual(['remote:a', 'C:/a']);
    expect(store.rows()[0].row?.health[0].run?.status).toBe('success');
  });

  it('keeps the last good overview beside an error', async () => {
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }], 5));
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(0);
    api.forgeOverviewRepo.mockRejectedValue({ kind: 'network', message: 'offline' });
    await store.refresh();
    const [entry] = store.rows();
    expect(entry.error?.kind).toBe('network');
    expect(entry.row?.health[0].run?.status).toBe('success');
  });

  it('fills pending checks after the list lands', async () => {
    api.forgeOverviewRepo.mockResolvedValue(overview([], [pull({ checksPending: true })]));
    api.forgePullChecks.mockResolvedValue([{ id: 'p1', checks: 'failure' }]);
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a', root: 'C:/a' }], 5));
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.forgePullChecks).toHaveBeenCalledWith('C:/a', [expect.objectContaining({ id: 'p1' })]);
    const p = store.rows()[0].row?.overview.pulls.items[0];
    expect(p).toMatchObject({ checks: 'failure', checksPending: false });
  });

  it('orders loaded rows by attention, pins without data after, and lists dashboard items', async () => {
    api.forgeOverviewRepo.mockImplementation(async (t: string) => {
      if (t === 'remote:b') return overview([run('main', 'failure')]);
      if (t === 'remote:c') return new Promise(() => {});
      return overview([run('main', 'success')]);
    });
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a' }, { repo: 'b' }, { repo: 'c' }], 5));
    store.setWanted('pane', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.rows().map((r) => r.pin.repo)).toEqual(['b', 'a', 'c']);
    expect(store.rows()[2]).toMatchObject({ row: null, loading: true });
    expect(store.items()).toEqual([expect.objectContaining({ kind: 'branch', repo: 'b', branch: 'main' })]);
  });

  it('pins and unpins by writing the whole array, keeping other fields', async () => {
    const store = new ForgeOverviewStore();
    store.applySettings(settings([{ repo: 'a', root: 'C:/a', branches: ['uat'] }, { repo: 'b' }]));
    await store.pin('c');
    expect(api.saveSetting).toHaveBeenLastCalledWith(
      ['forge', 'pinnedRepos'],
      [{ repo: 'a', root: 'C:/a', branches: ['uat'] }, { repo: 'b' }, { repo: 'c' }],
    );
    expect(store.isPinned('c')).toBe(true);

    await store.pin('a');
    expect(api.saveSetting).toHaveBeenCalledTimes(1);

    await store.pin('b', 'C:/b');
    expect(api.saveSetting).toHaveBeenLastCalledWith(
      ['forge', 'pinnedRepos'],
      [{ repo: 'a', root: 'C:/a', branches: ['uat'] }, { repo: 'b', root: 'C:/b' }, { repo: 'c' }],
    );

    await store.unpin('a');
    expect(api.saveSetting).toHaveBeenLastCalledWith(
      ['forge', 'pinnedRepos'],
      [{ repo: 'b', root: 'C:/b' }, { repo: 'c' }],
    );
    expect(store.isPinned('a')).toBe(false);
    await store.unpin('zzz');
    expect(api.saveSetting).toHaveBeenCalledTimes(3);
  });
});
