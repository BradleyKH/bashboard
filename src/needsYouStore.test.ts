import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeError, PullRequest, Run } from './forgeApi';
import type { NeedsItem, TerminalItem, UsageWindow } from './needsYouModel';
import type { DashboardItem } from './shipOverviewModel';
import type { OverviewEntry } from './shipOverviewStore';

vi.mock('./shipOverviewStore', () => ({
  shipOverviewStore: { items: () => [], rows: () => [], subscribe: () => () => {} },
}));

const { NeedsYouStore } = await import('./needsYouStore');

const MIN = 60_000;
let clock = Date.parse('2026-11-13T12:00:00Z');

class FakeShip {
  entries: OverviewEntry[] = [];
  dash: DashboardItem[] = [];
  private listeners = new Set<() => void>();
  items = (): DashboardItem[] => this.dash;
  rows = (): OverviewEntry[] => this.entries;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

const REPO = 'bitbucket.org/keysys/kweb';
const entry = (over: Partial<OverviewEntry> = {}): OverviewEntry => ({
  pin: { repo: REPO },
  row: null,
  error: null,
  loading: false,
  updatedAt: clock,
  ...over,
});
const signedOut = (): ForgeError => ({ kind: 'signedOut' }) as ForgeError;

const base = { target: `remote:${REPO}`, repo: REPO };
const run = (id = 'r1'): Run => ({ id, title: 'Deploy', name: 'Build', status: 'failure' }) as Run;
const pull = (updatedAt = '2026-11-13T10:00:00Z', number = 12): PullRequest =>
  ({ number, title: 'Add export', updatedAt, reviewers: [] }) as unknown as PullRequest;
const branch = (id = 'r1', since = clock - 10 * MIN): DashboardItem => ({
  ...base,
  kind: 'branch',
  tab: 'pipelines',
  branch: 'main',
  run: run(id),
  since,
});
const review = (updatedAt = '2026-11-13T10:00:00Z', number = 12, since = clock - 30 * MIN): DashboardItem => ({
  ...base,
  kind: 'review',
  tab: 'pulls',
  pull: pull(updatedAt, number),
  since,
});
const approved = (number = 20): DashboardItem => ({
  ...base,
  kind: 'approved',
  tab: 'pulls',
  pull: pull('2026-11-13T09:00:00Z', number),
  since: clock - 20 * MIN,
});
const term = (over: Partial<TerminalItem> = {}): TerminalItem => ({
  kind: 'terminal',
  paneId: 'p1',
  tabId: 't1',
  title: 'api-server',
  status: 'waiting',
  reason: '',
  since: clock - 4 * MIN,
  ...over,
});
const win = (over: Partial<UsageWindow> = {}): UsageWindow => ({
  agent: 'claude',
  agentName: 'Claude',
  label: '5-hour',
  percent: 84,
  resetsAt: clock + 60 * MIN,
  ...over,
});

let ship: FakeShip;
let store: InstanceType<typeof NeedsYouStore>;

/** Opens the startup gate: Ship polled with no items, and an empty terminal feed. */
function settle(): void {
  ship.entries = [entry()];
  ship.emit();
  store.setTerminals([]);
}

beforeEach(() => {
  clock = Date.parse('2026-11-13T12:00:00Z');
  ship = new FakeShip();
  ship.entries = [entry()];
  store = new NeedsYouStore(ship, () => clock);
});

const kinds = (items: readonly NeedsItem[]): string[] =>
  items.map((i) => (i.kind === 'ship' ? i.item.kind : i.kind === 'terminal' ? `terminal:${i.status}` : i.kind));

describe('composition', () => {
  it('orders terminals, Ship, sign-in, and usage by group, then age', () => {
    ship.dash = [approved(), review(), branch()];
    ship.entries = [entry({ error: signedOut(), updatedAt: null })];
    store.setUsage([win({ percent: 84 }), win({ label: 'weekly', percent: 100, resetsAt: clock + 2 * 60 * MIN })]);
    store.setTerminals([term({ paneId: 'a', status: 'done' }), term({ paneId: 'b', status: 'waiting' })]);
    ship.emit();
    expect(kinds(store.items())).toEqual([
      'terminal:waiting',
      'branch',
      'usage',
      'review',
      'approved',
      'terminal:done',
      'usage',
      'signIn',
    ]);
  });

  it('wraps a Ship item with its own since', () => {
    ship.dash = [review('2026-11-13T10:00:00Z', 12, 1234)];
    ship.emit();
    const item = store.items()[0];
    expect(item.kind === 'ship' && item.since).toBe(1234);
  });

  it('drops usage windows under the threshold and follows a changed threshold', () => {
    store.setUsage([win({ percent: 50 })]);
    expect(store.items()).toEqual([]);
    store.setUsagePercent(40);
    expect(kinds(store.items())).toEqual(['usage']);
  });

  it('drops a usage window whose reset time passed on refresh', () => {
    store.setUsage([win({ resetsAt: clock + MIN })]);
    expect(store.items()).toHaveLength(1);
    clock += 2 * MIN;
    store.refresh();
    expect(store.items()).toEqual([]);
  });

  it('replaces terminals wholesale', () => {
    store.setTerminals([term({ paneId: 'a' }), term({ paneId: 'b' })]);
    store.setTerminals([term({ paneId: 'b' })]);
    expect(store.items()).toHaveLength(1);
  });

  it('notifies subscribers on each input change', () => {
    const cb = vi.fn();
    store.subscribe(cb);
    store.setTerminals([]);
    store.setUsage([]);
    ship.emit();
    expect(cb).toHaveBeenCalledTimes(3);
  });
});

describe('first-seen times', () => {
  it('stamps usage and sign-in rows when first seen, and keeps the stamp across recomputes', () => {
    ship.entries = [entry({ error: signedOut(), updatedAt: null })];
    store.setUsage([win()]);
    const first = store.items().map((i) => i.since);
    expect(first).toEqual([clock, clock]);
    clock += 5 * MIN;
    store.setTerminals([]);
    expect(store.items().map((i) => i.since)).toEqual(first);
  });

  it('forgets a row that left, so its return starts a new age', () => {
    store.setUsage([win()]);
    const t0 = clock;
    clock += 5 * MIN;
    store.setUsage([]);
    clock += 5 * MIN;
    store.setUsage([win()]);
    const item = store.items()[0];
    expect(item.since).toBe(clock);
    expect(item.since).not.toBe(t0);
  });

  it('keeps the age of a row while it is hidden', () => {
    // A fixed reset time, since a new one would be a new window with its own age.
    const w = win();
    store.setUsage([w]);
    const t0 = clock;
    store.hide(store.items()[0]);
    clock += 5 * MIN;
    store.setUsage([w]);
    store.hydrateHides([]);
    expect(store.items()[0].since).toBe(t0);
  });
});

describe('hides', () => {
  it('hides a non-terminal row and brings it back when its state changes', () => {
    ship.dash = [review('2026-11-13T10:00:00Z')];
    ship.emit();
    store.hide(store.items()[0]);
    expect(store.items()).toEqual([]);
    ship.dash = [review('2026-11-13T11:30:00Z')];
    ship.emit();
    expect(store.items()).toHaveLength(1);
  });

  it('hides a failed branch until a newer run fails', () => {
    ship.dash = [branch('r1')];
    ship.emit();
    store.hide(store.items()[0]);
    ship.emit();
    expect(store.items()).toEqual([]);
    ship.dash = [branch('r2')];
    ship.emit();
    expect(store.items()).toHaveLength(1);
  });

  it('never hides a terminal', () => {
    store.setTerminals([term()]);
    store.hide(store.items()[0]);
    expect(store.items()).toHaveLength(1);
    expect(store.hides()).toEqual([]);
  });

  it('keeps one hide per row, replacing an older version', () => {
    ship.dash = [review('2026-11-13T10:00:00Z')];
    ship.emit();
    store.hide(store.items()[0]);
    ship.dash = [review('2026-11-13T11:00:00Z')];
    ship.emit();
    store.hide(store.items()[0]);
    expect(store.hides()).toHaveLength(1);
  });

  it('notifies hide subscribers on a hide but not on hydrate', () => {
    const cb = vi.fn();
    store.subscribeHides(cb);
    ship.dash = [review()];
    ship.emit();
    store.hide(store.items()[0]);
    expect(cb).toHaveBeenCalledTimes(1);
    store.hydrateHides(store.hides());
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('round-trips through hides() and hydrateHides()', () => {
    ship.dash = [review()];
    ship.emit();
    store.hide(store.items()[0]);
    const saved = store.hides();
    const fresh = new NeedsYouStore(ship, () => clock);
    fresh.hydrateHides(saved);
    ship.emit();
    expect(fresh.items()).toEqual([]);
  });

  it('prunes a Ship hide whose row is gone, once Ship has loaded, and tells hide subscribers', () => {
    ship.dash = [review('2026-11-13T10:00:00Z', 12)];
    settle();
    store.hide(store.items()[0]);
    const cb = vi.fn();
    store.subscribeHides(cb);
    ship.dash = [];
    ship.emit();
    expect(store.hides()).toEqual([]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('keeps hydrated hides until their own source has loaded', () => {
    ship.dash = [review()];
    ship.emit();
    store.hide(store.items()[0]);
    store.setUsage([win()]);
    store.hide(store.items().find((i) => i.kind === 'usage')!);
    const saved = store.hides();
    expect(saved).toHaveLength(2);

    const fresh = new NeedsYouStore(ship, () => clock);
    fresh.hydrateHides(saved);
    // Terminals and usage arrive first; Ship has not loaded, so its hide survives their recomputes.
    fresh.setTerminals([]);
    expect(fresh.hides()).toHaveLength(2);
    // Ship loads with the row gone: its hide is pruned, the usage hide is not (no setUsage yet).
    ship.dash = [];
    ship.entries = [entry()];
    ship.emit();
    expect(fresh.hides()).toHaveLength(1);
    // Usage loads empty: now that hide goes too.
    fresh.setUsage([]);
    expect(fresh.hides()).toEqual([]);
  });
});

describe('hides for a pin that cannot be read', () => {
  const hiddenReview = (): string[] => {
    ship.dash = [review('2026-11-13T10:00:00Z', 12)];
    ship.emit();
    store.hide(store.items()[0]);
    ship.dash = [];
    return store.hides();
  };

  it('survives an offline first poll, then prunes once the pin loads and the row is gone', () => {
    const saved = hiddenReview();
    const fresh = new NeedsYouStore(ship, () => clock);
    fresh.hydrateHides(saved);
    fresh.setTerminals([]);
    ship.entries = [entry({ error: { kind: 'network' } as unknown as ForgeError, updatedAt: null })];
    ship.emit();
    expect(fresh.hides()).toEqual(saved);
    // Still failing on a later poll after an earlier success: the last good row is gone from view, hides stay.
    ship.entries = [entry({ error: { kind: 'network' } as unknown as ForgeError })];
    ship.emit();
    expect(fresh.hides()).toEqual(saved);
    ship.entries = [entry()];
    ship.emit();
    expect(fresh.hides()).toEqual([]);
  });

  it('survives a pin that has not finished its first poll', () => {
    const saved = hiddenReview();
    const fresh = new NeedsYouStore(ship, () => clock);
    fresh.hydrateHides(saved);
    ship.entries = [entry({ updatedAt: null, error: signedOut() }), entry({ pin: { repo: 'github.com/a/b' }, loading: true, updatedAt: null })];
    ship.emit();
    expect(fresh.hides()).toEqual(saved);
  });

  it('drops hides for a repo that is no longer pinned', () => {
    const saved = hiddenReview();
    const fresh = new NeedsYouStore(ship, () => clock);
    fresh.hydrateHides(saved);
    ship.entries = [entry({ pin: { repo: 'github.com/a/b' } })];
    ship.emit();
    expect(fresh.hides()).toEqual([]);
  });
});

describe('walkItems', () => {
  it('returns every row, or only terminals when walkAll is false', () => {
    ship.dash = [review()];
    store.setUsage([win()]);
    store.setTerminals([term()]);
    ship.emit();
    expect(kinds(store.walkItems(true))).toEqual(['terminal:waiting', 'review', 'usage']);
    expect(kinds(store.walkItems(false))).toEqual(['terminal:waiting']);
  });
});

describe('entered urgent', () => {
  let entered: NeedsItem[][];
  beforeEach(() => {
    entered = [];
    store.onEnteredUrgent((items) => entered.push(items));
  });

  it('stays silent through the first load, including rows the last poll brings', () => {
    store.setTerminals([term()]);
    ship.entries = [entry({ loading: true, updatedAt: null })];
    ship.emit();
    ship.dash = [branch()];
    ship.entries = [entry()];
    ship.emit();
    expect(store.items()).toHaveLength(2);
    expect(entered).toEqual([]);
  });

  it('fires for a later new failure, but not for Ready rows or terminals', () => {
    ship.dash = [branch('r1')];
    settle();
    expect(entered).toEqual([]);
    ship.dash = [branch('r1'), branch('r2'), review('2026-11-13T10:00:00Z', 30), approved()];
    // A different branch name makes r2 a separate row.
    ship.dash[1] = { ...(ship.dash[1] as Extract<DashboardItem, { kind: 'branch' }>), branch: 'release' };
    store.setTerminals([term({ status: 'waiting' }), term({ paneId: 'p2', status: 'failed' })]);
    ship.emit();
    expect(entered).toHaveLength(1);
    expect(kinds(entered[0])).toEqual(['branch']);
    ship.emit();
    expect(entered).toHaveLength(1);
  });

  it('fires when a usage window crosses into Broken, not when it enters Ready', () => {
    settle();
    store.setUsage([win({ percent: 84 })]);
    expect(entered).toEqual([]);
    store.setUsage([win({ percent: 100 })]);
    expect(entered).toHaveLength(1);
    expect(kinds(entered[0])).toEqual(['usage']);
  });

  it('waits for the terminal feed as well as Ship', () => {
    ship.entries = [entry()];
    ship.emit();
    ship.dash = [branch()];
    ship.emit();
    expect(entered).toEqual([]);
    store.setTerminals([]);
    ship.dash = [branch(), { ...branch('r9'), branch: 'release' } as DashboardItem];
    ship.emit();
    expect(entered).toHaveLength(1);
  });

  it('opens the gate for a signed-out pin, which has an error and no update time', () => {
    store.setTerminals([]);
    ship.entries = [entry({ error: signedOut(), updatedAt: null })];
    ship.emit();
    store.setUsage([win({ percent: 100 })]);
    expect(entered).toHaveLength(1);
  });

  it('does not open the gate while a pin is still loading, and opens it with nothing pinned', () => {
    store.setTerminals([]);
    ship.entries = [entry({ loading: true })];
    ship.emit();
    store.setUsage([win({ percent: 100, label: 'a' })]);
    expect(entered).toEqual([]);
    ship.entries = [];
    ship.emit();
    store.setUsage([win({ percent: 100, label: 'a' }), win({ percent: 100, label: 'b' })]);
    expect(entered).toHaveLength(1);
  });

  it('does not fire for a row that was hidden and stays hidden', () => {
    ship.dash = [branch('r1')];
    settle();
    store.hide(store.items()[0]);
    ship.emit();
    expect(entered).toEqual([]);
  });
});

describe('activate', () => {
  const opener = () => ({ revealPane: vi.fn(), openShip: vi.fn(), openAccounts: vi.fn() });

  it('routes each row to its opener, and a usage row nowhere', () => {
    const o = opener();
    store.setOpener(o);
    ship.dash = [review()];
    ship.entries = [entry({ error: signedOut(), updatedAt: null })];
    store.setTerminals([term({ paneId: 'p9' })]);
    store.setUsage([win()]);
    ship.emit();
    for (const item of store.items()) store.activate(item);
    expect(o.revealPane).toHaveBeenCalledWith('p9');
    expect(o.openShip).toHaveBeenCalledWith(`remote:${REPO}`, 'pulls');
    expect(o.openAccounts).toHaveBeenCalledWith('bitbucket.org', { openTokenForm: true });
    expect(o.revealPane.mock.calls.length + o.openShip.mock.calls.length + o.openAccounts.mock.calls.length).toBe(3);
  });

  it('does nothing before an opener is set', () => {
    store.setTerminals([term()]);
    expect(() => store.activate(store.items()[0])).not.toThrow();
  });
});
