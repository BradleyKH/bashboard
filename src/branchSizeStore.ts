import { gitBranchSize, type BranchSize } from './branchSizeApi';
import { getHomeDir } from './displayPath';
import { samePath } from './favorites';
import { gitUnwatch, gitWatch, onGitChanged } from './gitApi';
import { repoRoot } from './repoFiles';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import { bindWindowVisibility } from './windowVisibility';

/**
 * The Rust watcher already debounces (1 s for worktree edits, 300 ms for metadata); this only
 * folds a burst of events that arrive together, such as a checkout touching refs and files.
 */
export const BRANCH_SIZE_DEBOUNCE_MS = 200;

/** One worktree as consumers see it: `size` is the last good count, kept beside a later `error`. */
export interface BranchSizeEntry {
  size: BranchSize | null;
  error: string | null;
  loading: boolean;
}

interface Tracked {
  root: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  inFlight: boolean;
  /** A change landed mid-fetch, so one more fetch runs when this one ends. */
  again: boolean;
  /** A fetch fell due while the window was hidden. */
  deferred: boolean;
  disposed: boolean;
}

/**
 * Branch size per worktree, shared by the dashboard's session cards, its Branch section, and every
 * Git pane. Consumers say which folders they show under their own key; the store resolves each to
 * its worktree, holds a git watch on every wanted worktree, and refetches on `git://changed` and on
 * `refresh`, never on a timer. Fetching pauses while the window is hidden and catches up on show.
 */
export class BranchSizeStore {
  private readonly entries = new Map<string, BranchSizeEntry>();
  /** Successful folder-to-worktree resolutions only, so a later `git init` is picked up. */
  private readonly resolved = new Map<string, string>();
  private readonly resolving = new Map<string, Promise<string | null>>();
  private readonly wantedBy = new Map<string, string[]>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly subscribers = new Set<() => void>();
  private thresholdValue = DEFAULT_SETTINGS.git.branchSizeThreshold;
  private visible = true;
  private started = false;
  private generation = 0;

  /** Does not call back immediately. Fires on any change to what the getters return. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** The line count at which the meter warns; 0 means the meter is off. */
  threshold(): number {
    return this.thresholdValue;
  }

  applySettings(settings: Pick<Settings, 'git'>): void {
    const next = settings.git.branchSizeThreshold;
    if (next === this.thresholdValue) return;
    this.thresholdValue = next;
    this.emit();
  }

  entryFor(folder: string): BranchSizeEntry | null {
    const root = this.resolved.get(folder);
    return root === undefined ? null : (this.entries.get(this.keyFor(root)) ?? null);
  }

  sizeFor(folder: string): BranchSize | null {
    return this.entryFor(folder)?.size ?? null;
  }

  /**
   * Each consumer sets its own `key`'s folders (`[]` drops the key); the wanted worktrees are the
   * union across keys, and a worktree stays watched until no key wants it.
   */
  setWanted(key: string, folders: string[]): void {
    this.start();
    if (folders.length === 0) this.wantedBy.delete(key);
    else this.wantedBy.set(key, [...folders]);
    void this.reconcile();
  }

  /** Refetches the worktree holding `folder` after a short debounce, as when an agent there stops. */
  refresh(folder: string): void {
    const root = this.resolved.get(folder);
    const rec = root === undefined ? undefined : this.tracked.get(this.keyFor(root));
    if (rec) this.request(rec);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    // The store lives for the whole session, so neither subscription is released.
    try {
      void Promise.resolve(onGitChanged((root) => this.onChanged(root))).catch(() => {});
    } catch {
      // No Tauri runtime (a plain browser): nothing emits.
    }
    bindWindowVisibility((visible) => {
      this.visible = visible;
      if (!visible) return;
      for (const rec of this.tracked.values()) {
        if (!rec.deferred) continue;
        rec.deferred = false;
        this.run(rec);
      }
    });
  }

  private onChanged(root: string): void {
    for (const rec of this.tracked.values()) {
      if (samePath(rec.root, root)) this.request(rec);
    }
  }

  /** The key a worktree's entry and watch are held under; `samePath`'s notion of equal. */
  private keyFor(root: string): string {
    return root.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  private resolve(folder: string): Promise<string | null> {
    const hit = this.resolved.get(folder);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.resolving.get(folder);
    if (pending) return pending;
    const p = repoRoot(folder).then(
      (info) => {
        if (!info.isGit) return null;
        this.resolved.set(folder, info.root);
        return info.root;
      },
      () => null,
    );
    this.resolving.set(folder, p);
    void p.finally(() => this.resolving.delete(folder));
    return p;
  }

  private async reconcile(): Promise<void> {
    const token = ++this.generation;
    const folders = [...new Set([...this.wantedBy.values()].flat())];
    const roots = await Promise.all(folders.map((f) => this.resolve(f)));
    // A later call has the newer wanted set and awaits the same resolutions.
    if (token !== this.generation) return;
    const home = getHomeDir();
    const want = new Map<string, string>();
    for (const root of roots) {
      // A dotfiles repo at home would put a recursive watcher over the whole home folder.
      if (root === null || (home !== null && samePath(root, home))) continue;
      want.set(this.keyFor(root), root);
    }
    for (const [k, rec] of [...this.tracked]) {
      if (want.has(k)) continue;
      this.release(rec);
      this.tracked.delete(k);
    }
    for (const [k, root] of want) {
      if (this.tracked.has(k)) continue;
      const rec: Tracked = { root, timer: undefined, inFlight: false, again: false, deferred: false, disposed: false };
      this.tracked.set(k, rec);
      this.acquire(rec);
      this.run(rec);
    }
    this.emit();
  }

  private acquire(rec: Tracked): void {
    gitWatch(rec.root).then(
      () => {
        // Dropped while the watch was being acquired: give it straight back.
        if (rec.disposed) void gitUnwatch(rec.root).catch(() => {});
      },
      () => {
        // Nothing was acquired, so nothing to release; fetches still run on demand.
      },
    );
  }

  private release(rec: Tracked): void {
    rec.disposed = true;
    clearTimeout(rec.timer);
    rec.timer = undefined;
    void gitUnwatch(rec.root).catch(() => {});
  }

  private request(rec: Tracked): void {
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      rec.timer = undefined;
      this.run(rec);
    }, BRANCH_SIZE_DEBOUNCE_MS);
  }

  private run(rec: Tracked): void {
    if (rec.disposed) return;
    if (!this.visible) {
      rec.deferred = true;
      return;
    }
    if (rec.inFlight) {
      rec.again = true;
      return;
    }
    void this.fetch(rec);
  }

  private async fetch(rec: Tracked): Promise<void> {
    rec.inFlight = true;
    rec.again = false;
    const key = this.keyFor(rec.root);
    const prev = this.entries.get(key);
    this.entries.set(key, { size: prev?.size ?? null, error: null, loading: true });
    this.emit();
    try {
      const size = await gitBranchSize(rec.root);
      this.entries.set(key, { size, error: null, loading: false });
    } catch (e) {
      this.entries.set(key, { size: prev?.size ?? null, error: String(e), loading: false });
    } finally {
      rec.inFlight = false;
    }
    this.emit();
    if (rec.again) this.run(rec);
  }

  private emit(): void {
    for (const cb of [...this.subscribers]) cb();
  }
}

export const branchSizeStore = new BranchSizeStore();
