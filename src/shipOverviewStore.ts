import {
  asForgeError,
  forgeOverviewRepo,
  forgePullChecks,
  onForgeAuthChanged,
  type ForgeError,
  type OverviewRepo,
  type PinnedRepo,
} from './forgeApi';
import { withPullChecks } from './shipModel';
import {
  bitbucketFloorMs,
  buildRow,
  dashboardItems,
  FAST_POLL_MS,
  isBitbucketPin,
  nextPollMs,
  orderRows,
  targetKey,
  type DashboardItem,
  type OverviewRow,
} from './shipOverviewModel';
import { saveSetting, type Settings } from './settings';
import { isWindowVisible } from './windowVisibility';

/** The first round's polls start within this window, so pins do not all hit the host at once. */
const STAGGER_SPREAD_MS = 3000;
const STAGGER_STEP_MAX_MS = 500;
/** Retry spacing after a rate limit that names no wait. */
const RATE_LIMIT_FALLBACK_SECS = 60;

/** One pin as the Overview shows it: `row` is the last good overview, kept beside a later `error`. */
export interface OverviewEntry {
  pin: PinnedRepo;
  row: OverviewRow | null;
  error: ForgeError | null;
  loading: boolean;
  /** Epoch ms of the last successful poll. */
  updatedAt: number | null;
}

interface Entry {
  pin: PinnedRepo;
  overview: OverviewRepo | null;
  row: OverviewRow | null;
  error: ForgeError | null;
  updatedAt: number | null;
  /** Epoch ms the last poll finished, good or bad; null until the first one. */
  polledAt: number | null;
  /** Delay after `polledAt` to the next poll; null means only on demand. */
  nextDelayMs: number | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  inFlight: boolean;
  // Bumped when the pin's target changes, so a reply for the old target is dropped.
  epoch: number;
  // Set when the target changed under an in-flight poll, so that poll asks again when it ends.
  stale: boolean;
}

const sameBranches = (a: PinnedRepo, b: PinnedRepo): boolean =>
  JSON.stringify(a.branches ?? []) === JSON.stringify(b.branches ?? []);

/**
 * Every pinned repo's Overview data, shared by the Ship pane's Overview tab and the dashboard's
 * Ship section (docs/design/ship.md section 4.20). Each repo polls on its own cadence (fast while a
 * watched branch is running, else the heartbeat) only while some consumer wants it and the window
 * is visible, and catches up on what fell due when either returns.
 */
export class ShipOverviewStore {
  private entries = new Map<string, Entry>();
  private pins: PinnedRepo[] = [];
  private minutes = 0;
  private readonly wanted = new Set<string>();
  private readonly subscribers = new Set<() => void>();
  private readonly onVisibility = (): void => {
    if (this.visible() && this.wanted.size > 0) this.catchUp();
  };

  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    // The store lives for the whole session, so the subscription is never released.
    try {
      void Promise.resolve(onForgeAuthChanged(({ host }) => void this.refreshHost(host))).catch(() => {});
    } catch {
      // No Tauri runtime (a plain browser or a test): nothing emits, so there is nothing to follow.
    }
  }

  /** Polls the pins on `host` after its credentials changed; an empty host means any of them may have. */
  async refreshHost(host: string): Promise<void> {
    const want = host.toLowerCase();
    const due = [...this.entries.values()].filter((e) => {
      const pinHost = e.pin.repo.split('/')[0].toLowerCase();
      return want === '' || pinHost === '' || pinHost === want;
    });
    await Promise.all(due.map((e) => this.poll(e)));
  }

  /** One entry per pin: loaded rows by attention, then the rest in pin order. */
  rows(): OverviewEntry[] {
    const all = [...this.entries.values()];
    const loaded = all.filter((e) => e.row !== null);
    const byRow = new Map(loaded.map((e) => [e.row as OverviewRow, e]));
    const ordered = orderRows(loaded.map((e) => e.row as OverviewRow)).map((r) => byRow.get(r) as Entry);
    return [...ordered, ...all.filter((e) => e.row === null)].map((e) => ({
      pin: e.pin,
      row: e.row,
      error: e.error,
      loading: e.inFlight,
      updatedAt: e.updatedAt,
    }));
  }

  /** The dashboard's high-priority items, from loaded rows only. */
  items(): DashboardItem[] {
    const rows = [...this.entries.values()].flatMap((e) => (e.row ? [e.row] : []));
    return dashboardItems(orderRows(rows));
  }

  /** The newest successful poll across every pin, or null before the first. */
  lastUpdated(): number | null {
    let latest: number | null = null;
    for (const e of this.entries.values()) {
      if (e.updatedAt !== null && (latest === null || e.updatedAt > latest)) latest = e.updatedAt;
    }
    return latest;
  }

  /**
   * The gap Bitbucket pins are held to when the request budget slows them below the usual 60 s
   * running poll, else null.
   */
  bitbucketSlowedMs(): number | null {
    const floor = this.bitbucketFloor();
    return floor > FAST_POLL_MS ? floor : null;
  }

  isPinned(repo: string): boolean {
    return this.entries.has(repo);
  }

  /** Does not call back immediately. Fires on any change to what the getters return. */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Each consumer turns its own `key` on and off; polling runs while any key is on. */
  setWanted(key: string, on: boolean): void {
    const was = this.wanted.size > 0;
    if (on) this.wanted.add(key);
    else this.wanted.delete(key);
    const now = this.wanted.size > 0;
    if (now === was) return;
    if (now) {
      if (this.visible()) this.catchUp();
    } else {
      for (const e of this.entries.values()) this.cancelTimer(e);
    }
  }

  /** Polls every pin now, as after a Refresh, rather than waiting out its interval. */
  async refresh(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.poll(e)));
  }

  /** Reconciles the entries with `ship.pinnedRepos` and picks up the heartbeat. */
  applySettings(settings: Settings): void {
    this.reconcile(settings.ship.pinnedRepos, settings.ship.overviewRefreshMinutes);
  }

  /** Pins `repo`, or sets the clone of one already pinned; other pins keep their fields. */
  async pin(repo: string, root?: string): Promise<void> {
    const at = this.pins.findIndex((p) => p.repo === repo);
    let next: PinnedRepo[];
    if (at < 0) next = [...this.pins, root ? { repo, root } : { repo }];
    else if (root && this.pins[at].root !== root) next = this.pins.map((p, i) => (i === at ? { ...p, root } : p));
    else return;
    await this.write(next);
  }

  /** Pins each repo not already pinned, in one settings write; pins already there are left alone. */
  async pinAll(list: readonly PinnedRepo[]): Promise<void> {
    const add = list.filter((p, i) => !this.pins.some((q) => q.repo === p.repo) && list.findIndex((q) => q.repo === p.repo) === i);
    if (add.length > 0) await this.write([...this.pins, ...add]);
  }

  async unpin(repo: string): Promise<void> {
    if (!this.pins.some((p) => p.repo === repo)) return;
    await this.write(this.pins.filter((p) => p.repo !== repo));
  }

  private async write(next: PinnedRepo[]): Promise<void> {
    await saveSetting(['ship', 'pinnedRepos'], next);
    // Hot reload brings the same array back; applying it now lets a second edit build on this one.
    this.reconcile(next, this.minutes);
  }

  private reconcile(pins: readonly PinnedRepo[], minutes: number): void {
    const unique = pins.filter((p, i) => pins.findIndex((q) => q.repo === p.repo) === i);
    const heartbeatChanged = minutes !== this.minutes;
    const floorBefore = this.bitbucketFloor();
    this.minutes = minutes;
    this.pins = unique.map((p) => ({ ...p }));
    // A new heartbeat or Bitbucket pin count retimes the pins already waiting on their next poll.
    const retime = heartbeatChanged || this.bitbucketFloor() !== floorBefore;
    const next = new Map<string, Entry>();
    const repoll: Entry[] = [];
    for (const pin of this.pins) {
      const e = this.entries.get(pin.repo);
      if (!e) {
        next.set(pin.repo, this.newEntry(pin));
        continue;
      }
      const old = e.pin;
      e.pin = pin;
      let rebuilt = false;
      if (targetKey(old) !== targetKey(pin)) {
        e.epoch += 1;
        e.stale = e.inFlight;
        if (!e.inFlight) repoll.push(e);
      } else if (!sameBranches(old, pin) && e.overview) {
        e.row = buildRow(pin, e.overview);
        rebuilt = true;
      }
      // A rebuilt row can gain a running branch, which polls on the fast cadence from now.
      if ((retime || rebuilt) && !e.inFlight) e.nextDelayMs = this.delayFor(e, e.error);
      next.set(pin.repo, e);
    }
    for (const [repo, e] of this.entries) {
      if (!next.has(repo)) this.cancelTimer(e);
    }
    this.entries = next;
    this.emit();
    if (this.wanted.size === 0 || !this.visible()) return;
    for (const e of repoll) void this.poll(e);
    this.catchUp();
  }

  private newEntry(pin: PinnedRepo): Entry {
    return {
      pin,
      overview: null,
      row: null,
      error: null,
      updatedAt: null,
      polledAt: null,
      nextDelayMs: null,
      timer: undefined,
      inFlight: false,
      epoch: 0,
      stale: false,
    };
  }

  private visible(): boolean {
    if (typeof document === 'undefined') return true;
    return isWindowVisible(document.visibilityState === 'visible', false);
  }

  private emit(): void {
    for (const cb of [...this.subscribers]) cb();
  }

  private cancelTimer(e: Entry): void {
    clearTimeout(e.timer);
    e.timer = undefined;
  }

  private live(e: Entry): boolean {
    return this.entries.get(e.pin.repo) === e;
  }

  /** Polls what fell due, staggering pins never polled, and times the rest from their last poll. */
  private catchUp(): void {
    const fresh = [...this.entries.values()].filter((e) => !e.inFlight && e.polledAt === null);
    const step = fresh.length > 1 ? Math.min(STAGGER_STEP_MAX_MS, STAGGER_SPREAD_MS / (fresh.length - 1)) : 0;
    fresh.forEach((e, i) => this.arm(e, i * step));
    for (const e of this.entries.values()) {
      if (!e.inFlight && e.polledAt !== null) this.schedule(e);
    }
  }

  private schedule(e: Entry): void {
    this.cancelTimer(e);
    if (e.polledAt === null || e.nextDelayMs === null) return;
    this.arm(e, e.polledAt + e.nextDelayMs - Date.now());
  }

  private arm(e: Entry, delayMs: number): void {
    this.cancelTimer(e);
    if (this.wanted.size === 0) return;
    if (delayMs <= 0) {
      if (this.visible()) void this.poll(e);
      return;
    }
    e.timer = setTimeout(() => {
      e.timer = undefined;
      // A hidden window skips the poll; the visibility listener catches up when it comes back.
      if (this.visible() && this.wanted.size > 0) void this.poll(e);
    }, delayMs);
  }

  private delayFor(e: Entry, err: ForgeError | null): number | null {
    if (err?.kind === 'rateLimited') return Math.max(err.retryAfterSecs ?? RATE_LIMIT_FALLBACK_SECS, 1) * 1000;
    return nextPollMs(e.row?.overview.runs ?? [], this.minutes, isBitbucketPin(e.pin.repo) ? this.bitbucketFloor() : 0);
  }

  private bitbucketFloor(): number {
    return bitbucketFloorMs(this.pins.filter((p) => isBitbucketPin(p.repo)).length);
  }

  private async poll(e: Entry): Promise<void> {
    if (e.inFlight || !this.live(e)) return;
    e.inFlight = true;
    e.stale = false;
    this.cancelTimer(e);
    this.emit();
    const epoch = e.epoch;
    const target = targetKey(e.pin);
    let err: ForgeError | null = null;
    try {
      const overview = await forgeOverviewRepo(target);
      if (epoch === e.epoch && this.live(e)) {
        e.overview = overview;
        e.row = buildRow(e.pin, overview);
        e.error = null;
        e.updatedAt = Date.now();
        this.emit();
        await this.fillPullChecks(e, epoch, target);
      }
    } catch (caught) {
      err = asForgeError(caught);
      if (epoch === e.epoch && this.live(e)) e.error = err;
    } finally {
      e.inFlight = false;
    }
    if (!this.live(e)) return;
    if (e.stale) {
      void this.poll(e);
      return;
    }
    e.polledAt = Date.now();
    e.nextDelayMs = this.delayFor(e, err);
    this.emit();
    this.schedule(e);
  }

  /** Fetches the checks the list left pending, so rows show first and their status arrives after. */
  private async fillPullChecks(e: Entry, epoch: number, target: string): Promise<void> {
    const overview = e.overview;
    if (!overview) return;
    const pending = overview.pulls.items.filter((p) => p.checksPending);
    if (pending.length === 0) return;
    let found: Awaited<ReturnType<typeof forgePullChecks>> = [];
    try {
      found = await forgePullChecks(target, pending);
    } catch {
      // The rows keep showing; they lose only the pending mark, and the next poll asks again.
    }
    if (epoch !== e.epoch || !this.live(e) || e.overview !== overview) return;
    e.overview = { ...overview, pulls: { ...overview.pulls, items: withPullChecks(overview.pulls.items, found) } };
    e.row = buildRow(e.pin, e.overview);
    this.emit();
  }
}

export const shipOverviewStore = new ShipOverviewStore();
