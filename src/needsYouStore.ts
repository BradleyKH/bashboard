import {
  applyHides,
  enteredUrgent,
  hideIdentity,
  hideKey,
  hideSource,
  hideTarget,
  orderItems,
  pruneHides,
  stableKey,
  usageItems,
  type NeedsItem,
  type SignInItem,
  type TerminalItem,
  type UsageWindow,
} from './needsYouModel';
import type { ShipTab } from './shipModel';
import { targetKey, type DashboardItem } from './shipOverviewModel';
import { shipOverviewStore, type OverviewEntry } from './shipOverviewStore';
import { signInLine } from './shipSectionModel';

/** Where a row's click goes; `main.ts` supplies these from the workspace and the dialogs. */
export interface NeedsOpener {
  revealPane(paneId: string): void;
  /** Drills into `target` on `tab`; null opens the Ship Overview itself. */
  openShip(target: string | null, tab?: ShipTab): void;
  /** Opens the Accounts tab on `host`; null leaves the choice of host to the tab. */
  openAccounts(host: string | null, opts?: { openTokenForm?: boolean; org?: string }): void;
}

/** What the store reads of the Ship store; a seam so tests need no forge. */
export interface ShipFeed {
  items(): DashboardItem[];
  rows(): OverviewEntry[];
  subscribe(listener: () => void): () => void;
}

/**
 * The one "Needs you" list (docs/design/dashboard.md section 4.28): terminals pushed by the
 * workspace, Ship's items and sign-in row read from the Ship store, and usage windows pushed by
 * the usage feed, composed and ordered by `needsYouModel.ts` with the user's hides applied.
 */
export class NeedsYouStore {
  private terminals: TerminalItem[] = [];
  private windows: UsageWindow[] = [];
  private usagePercent = 80;
  private hideSet = new Set<string>();
  private composed: NeedsItem[] = [];
  private visible: NeedsItem[] = [];
  private opener: NeedsOpener | null = null;
  /** Epoch ms a usage or sign-in row first appeared, keyed by stable key; entries leave with their row. */
  private firstSeen = new Map<string, number>();
  private prevKeys = new Set<string>();

  // Hydrated hides arrive before any data, so each feed's hides are pruned only once it has loaded.
  private shipLoaded = false;
  private usageLoaded = false;
  private terminalsLoaded = false;
  /** Opens with the first Ship load and the first terminal feed; until then nothing toasts. */
  private gateOpen = false;

  private readonly subscribers = new Set<() => void>();
  private readonly hideSubscribers = new Set<() => void>();
  private readonly urgentCallbacks = new Set<(items: NeedsItem[]) => void>();

  constructor(
    private readonly ship: ShipFeed = shipOverviewStore,
    private readonly now: () => number = Date.now,
  ) {
    // The store lives for the whole session, so the subscription is never released.
    ship.subscribe(() => this.onShipChange());
  }

  /** Ordered, hides applied. */
  items(): NeedsItem[] {
    return this.visible;
  }

  /** The Ctrl+Shift+N order; `walkAll` false leaves out everything but terminals. */
  walkItems(walkAll: boolean): NeedsItem[] {
    return walkAll ? this.visible : this.visible.filter((i) => i.kind === 'terminal');
  }

  /** Does not call back immediately. Fires on any recompute. */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Fires when the hide set changes (a hide, or a prune), so persistence can follow; not on hydrate. */
  subscribeHides(listener: () => void): () => void {
    this.hideSubscribers.add(listener);
    return () => this.hideSubscribers.delete(listener);
  }

  /** Fires with the non-terminal rows that newly became Blocked or Broken; silent until startup settles. */
  onEnteredUrgent(cb: (items: NeedsItem[]) => void): () => void {
    this.urgentCallbacks.add(cb);
    return () => this.urgentCallbacks.delete(cb);
  }

  /** Replaces every terminal row. */
  setTerminals(items: readonly TerminalItem[]): void {
    this.terminals = [...items];
    this.terminalsLoaded = true;
    this.recompute();
  }

  /** Replaces every usage window; the first call marks the usage feed as loaded. */
  setUsage(windows: readonly UsageWindow[]): void {
    this.windows = [...windows];
    this.usageLoaded = true;
    this.recompute();
  }

  setUsagePercent(percent: number): void {
    if (percent === this.usagePercent) return;
    this.usagePercent = percent;
    this.recompute();
  }

  /** Recomputes without new input, so a usage window whose reset time passed drops out. */
  refresh(): void {
    this.recompute();
  }

  /** Replaces the hide set with the persisted keys. */
  hydrateHides(keys: Iterable<string>): void {
    this.hideSet = new Set(keys);
    this.recompute();
  }

  /** Hides a non-terminal row until its state version changes; a terminal row has no hide key. */
  hide(item: NeedsItem): void {
    const key = hideKey(item);
    if (key === null) return;
    // An older hide of the same row is a dead version; drop it rather than carry it.
    const identity = hideIdentity(key);
    const next = new Set([...this.hideSet].filter((k) => hideIdentity(k) !== identity));
    next.add(key);
    this.hideSet = next;
    this.emitHides();
    this.recompute();
  }

  /** The hide keys to persist. */
  hides(): string[] {
    return [...this.hideSet];
  }

  setOpener(opener: NeedsOpener): void {
    this.opener = opener;
  }

  /** Takes the user to the row's subject; a usage row has nowhere to go. */
  activate(item: NeedsItem): void {
    const o = this.opener;
    if (!o) return;
    switch (item.kind) {
      case 'terminal':
        o.revealPane(item.paneId);
        return;
      case 'ship':
        o.openShip(item.item.target, item.item.tab);
        return;
      case 'signIn':
        o.openAccounts(item.host, { openTokenForm: item.openTokenForm, ...(item.org ? { org: item.org } : {}) });
        return;
      case 'usage':
        return;
    }
  }

  /**
   * "First Ship load" means every pinned repo has finished a poll, good or bad (`updatedAt` is set
   * only on success, so a signed-out pin counts by its error), or nothing is pinned. Only a Ship
   * notification evaluates it: an empty row list before the pins are applied would otherwise pass.
   */
  private onShipChange(): void {
    if (!this.shipLoaded && this.ship.rows().every((e) => !e.loading && (e.updatedAt !== null || e.error !== null))) {
      this.shipLoaded = true;
    }
    this.recompute();
  }

  private compose(now: number): NeedsItem[] {
    const ship: NeedsItem[] = this.ship.items().map((item) => ({ kind: 'ship', item, since: item.since }));
    const line = signInLine(this.ship.rows());
    const signIn: SignInItem[] = line ? [{ kind: 'signIn', ...line }] : [];
    const stamped = [...signIn, ...usageItems(this.windows, this.usagePercent, now)];
    // Usage and sign-in sources carry no time, so a row ages from when it was first seen here.
    const seen = new Map<string, number>();
    const rows = stamped.map((item) => {
      const key = stableKey(item);
      const since = this.firstSeen.get(key) ?? now;
      seen.set(key, since);
      return { ...item, since };
    });
    this.firstSeen = seen;
    return [...this.terminals, ...ship, ...rows];
  }

  /**
   * A Ship hide goes only when its pin is gone, or the pin loaded cleanly and no current row has
   * its identity. A pin that has not loaded or whose latest poll failed shows no rows, so its
   * hides must survive being offline.
   */
  private keepHide(k: string, live: ReadonlySet<string>, pins: ReadonlyMap<string, OverviewEntry>): boolean {
    if (hideSource(k) === 'usage') return live.has(k) || !this.usageLoaded;
    if (!this.shipLoaded) return true;
    const target = hideTarget(k);
    if (target === null) return live.has(k);
    const pin = pins.get(target);
    if (!pin) return false;
    if (pin.updatedAt === null || pin.error !== null) return true;
    return live.has(k);
  }

  private prunedHides(composed: readonly NeedsItem[]): Set<string> {
    const live = pruneHides(this.hideSet, composed);
    const pins = new Map(this.ship.rows().map((e) => [targetKey(e.pin), e]));
    return new Set([...this.hideSet].filter((k) => this.keepHide(k, live, pins)));
  }

  private recompute(): void {
    this.composed = this.compose(this.now());
    const pruned = this.prunedHides(this.composed);
    const hidesChanged = pruned.size !== this.hideSet.size;
    this.hideSet = pruned;
    this.visible = orderItems(applyHides(this.composed, this.hideSet));

    // The recompute that opens the gate is the baseline, so rows from the first load never toast.
    const wasOpen = this.gateOpen;
    this.gateOpen = this.shipLoaded && this.terminalsLoaded;
    const entered = wasOpen ? enteredUrgent(this.prevKeys, this.visible) : [];
    this.prevKeys = new Set(this.visible.map(stableKey));

    if (hidesChanged) this.emitHides();
    for (const cb of [...this.subscribers]) cb();
    if (entered.length > 0) for (const cb of [...this.urgentCallbacks]) cb(entered);
  }

  private emitHides(): void {
    for (const cb of [...this.hideSubscribers]) cb();
  }
}

export const needsYouStore = new NeedsYouStore();
