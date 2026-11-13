// Binds new CI runs to the terminal pane on their branch and follows them to their finish
// (docs/design/ship.md section 4.26). Display only: nothing is typed into a pane. The forge is read
// only after a git metadata change on a worktree with terminals, and polled only while a bound run
// is active, so an idle workspace costs no host calls.
import { getHomeDir } from './displayPath';
import { samePath } from './favorites';
import { forgeRuns, type Run } from './forgeApi';
import { gitUnwatch, gitWatch, onGitChanged } from './gitApi';
import { isRunActive, newRuns, paneRunOf, runFinish, type PaneRun } from './paneRunModel';
import { repoRoot } from './repoFiles';
import { FAST_POLL_MS } from './shipOverviewModel';
import { bindWindowVisibility } from './windowVisibility';

/** Folds a checkout's burst of ref and file events into one. */
export const RUN_DEBOUNCE_MS = 200;
/** A metadata change also fires for local commits and fetches; only a push moves the run list. */
export const RUN_THROTTLE_MS = 30_000;
/** A list older than this is no baseline: runs created since then are other people's, not this change's. */
const STALE_LIST_MS = 5 * 60 * 1000;

export interface RunTerminal {
  paneId: string;
  cwd: string | null;
}

export interface FolderRepo {
  root: string;
  branch: string | null;
}

type Timer = ReturnType<typeof setTimeout>;

export interface PaneRunDeps {
  forgeRuns(root: string, branch: string): Promise<Run[]>;
  onGitChanged(cb: (root: string, metadata: boolean) => void): void;
  gitWatch(root: string): Promise<void>;
  gitUnwatch(root: string): Promise<void>;
  /** The folder's worktree root and branch, or null outside a repo (and for a dotfiles repo at home). */
  resolve(folder: string): Promise<FolderRepo | null>;
  now(): number;
  setTimer(fn: () => void, ms: number): Timer;
  clearTimer(timer: Timer | undefined): void;
  bindVisibility(cb: (visible: boolean) => void): void;
  /** The pane's run to show, or null to show none. */
  bind(paneId: string, run: PaneRun | null): void;
  /** A run bound to the pane finished; the caller skips the mark when the pane is seen. */
  finish(paneId: string, kind: 'done' | 'failed'): void;
}

interface Watched {
  root: string;
  disposed: boolean;
  /** Set once `gitWatch` resolves; the backend counts references by root, so only a held one is given back. */
  acquired: boolean;
  debounce: Timer | undefined;
}

interface KeyState {
  root: string;
  branch: string;
  /** The last list read, the baseline `newRuns` compares against. */
  runs: Run[] | null;
  listAt: number;
  readAt: number;
  /** The metadata change a pending read answers, passed to `newRuns` as `triggerAt`. */
  triggerAt: number | null;
  /** A trigger read that bound nothing looks once more: the host creates the run seconds after a push. */
  followUp: boolean;
  bound: Map<string, Run>;
  timer: Timer | undefined;
  dueAt: number;
  inFlight: boolean;
  again: boolean;
  deferred: boolean;
  disposed: boolean;
}

/** `samePath`'s notion of equal, as a map key. */
function rootKey(root: string): string {
  return root.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

function keyOf(repo: FolderRepo): string | null {
  return repo.branch === null ? null : `${rootKey(repo.root)}\n${repo.branch}`;
}

export class PaneRunTracker {
  /** Most recently focused first; the first one on a key takes its new runs. */
  private panes: RunTerminal[] = [];
  private readonly folders = new Map<string, FolderRepo | null>();
  private readonly resolving = new Set<string>();
  /** Folders re-resolving after a metadata change, to the change's time. */
  private readonly changedAt = new Map<string, number>();
  private readonly watched = new Map<string, Watched>();
  private readonly keys = new Map<string, KeyState>();
  /** Each pane's displayed run, by key, so leaving the key clears it. */
  private readonly shown = new Map<string, string>();
  private visible = true;
  private started = false;
  private disposed = false;

  constructor(private readonly deps: PaneRunDeps) {}

  setPanes(panes: RunTerminal[]): void {
    if (this.disposed) return;
    this.start();
    this.panes = panes.map((p) => ({ ...p }));
    for (const p of this.panes) if (p.cwd && !this.folders.has(p.cwd)) this.resolveFolder(p.cwd);
    this.reconcile();
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.watched.values()) this.release(w);
    this.watched.clear();
    for (const k of this.keys.values()) this.dropKey(k);
    this.keys.clear();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.onGitChanged((root, metadata) => this.onChanged(root, metadata));
    this.deps.bindVisibility((visible) => {
      this.visible = visible;
      if (!visible) return;
      for (const k of this.keys.values()) {
        if (!k.deferred) continue;
        k.deferred = false;
        void this.read(k);
      }
    });
  }

  private resolveFolder(folder: string): void {
    if (this.resolving.has(folder)) return;
    this.resolving.add(folder);
    this.deps.resolve(folder).then(
      (repo) => this.resolved(folder, repo),
      () => this.resolved(folder, null),
    );
  }

  private resolved(folder: string, repo: FolderRepo | null): void {
    this.resolving.delete(folder);
    if (this.disposed) return;
    this.folders.set(folder, repo);
    this.reconcile();
    // A refresh after a metadata change: the change may be the push this branch's run answers.
    const at = this.changedAt.get(folder);
    this.changedAt.delete(folder);
    const k = repo === null ? undefined : this.keyFor(repo);
    if (at !== undefined && k) this.request(k, at);
  }

  private keyFor(repo: FolderRepo): KeyState | undefined {
    const key = keyOf(repo);
    return key === null ? undefined : this.keys.get(key);
  }

  private paneKey(p: RunTerminal): string | null {
    const repo = p.cwd ? this.folders.get(p.cwd) : undefined;
    return repo ? keyOf(repo) : null;
  }

  /** Brings watches, keys, and shown runs in line with the panes and their resolved folders. */
  private reconcile(): void {
    const wantRoots = new Map<string, string>();
    const wantKeys = new Map<string, FolderRepo>();
    const paneKeys = new Map<string, string | null>();
    for (const p of this.panes) {
      const repo = p.cwd ? this.folders.get(p.cwd) : undefined;
      paneKeys.set(p.paneId, repo ? keyOf(repo) : null);
      if (!repo) continue;
      wantRoots.set(rootKey(repo.root), repo.root);
      const key = keyOf(repo);
      if (key !== null) wantKeys.set(key, repo);
    }
    for (const [key, w] of [...this.watched]) {
      if (wantRoots.has(key)) continue;
      this.release(w);
      this.watched.delete(key);
    }
    for (const [key, root] of wantRoots) {
      if (this.watched.has(key)) continue;
      const w: Watched = { root, disposed: false, acquired: false, debounce: undefined };
      this.watched.set(key, w);
      this.acquire(w);
    }
    // A pane that closed is forgotten by the workspace; one that left the key shows nothing.
    for (const [paneId, key] of [...this.shown]) {
      if (paneKeys.get(paneId) === key) continue;
      this.shown.delete(paneId);
      this.keys.get(key)?.bound.delete(paneId);
      if (paneKeys.has(paneId)) this.deps.bind(paneId, null);
    }
    for (const [key, k] of [...this.keys]) {
      if (wantKeys.has(key)) continue;
      this.dropKey(k);
      this.keys.delete(key);
    }
    for (const [key, repo] of wantKeys) {
      if (this.keys.has(key) || repo.branch === null) continue;
      this.keys.set(key, {
        root: repo.root,
        branch: repo.branch,
        runs: null,
        listAt: 0,
        readAt: 0,
        triggerAt: null,
        followUp: false,
        bound: new Map(),
        timer: undefined,
        dueAt: 0,
        inFlight: false,
        again: false,
        deferred: false,
        disposed: false,
      });
    }
  }

  private acquire(w: Watched): void {
    this.deps.gitWatch(w.root).then(
      () => {
        // Dropped while the watch was being acquired: give it straight back.
        if (w.disposed) void this.deps.gitUnwatch(w.root).catch(() => {});
        else w.acquired = true;
      },
      () => {
        // Nothing was acquired, so nothing to release.
      },
    );
  }

  private release(w: Watched): void {
    w.disposed = true;
    this.deps.clearTimer(w.debounce);
    if (w.acquired) void this.deps.gitUnwatch(w.root).catch(() => {});
  }

  private dropKey(k: KeyState): void {
    k.disposed = true;
    this.deps.clearTimer(k.timer);
    k.timer = undefined;
  }

  private onChanged(root: string, metadata: boolean): void {
    if (!metadata || this.disposed) return;
    const w = this.watched.get(rootKey(root));
    if (!w) return;
    const at = this.deps.now();
    this.deps.clearTimer(w.debounce);
    w.debounce = this.deps.setTimer(() => {
      w.debounce = undefined;
      if (w.disposed) return;
      // The branch may have changed under every folder in this worktree; each re-resolve then asks for a read.
      const key = rootKey(w.root);
      for (const [folder, repo] of this.folders) {
        if (repo === null || rootKey(repo.root) !== key) continue;
        this.changedAt.set(folder, Math.min(at, this.changedAt.get(folder) ?? at));
        this.resolveFolder(folder);
      }
    }, RUN_DEBOUNCE_MS);
  }

  /** A read for a metadata change at `at`, at most once per throttle window. */
  private request(k: KeyState, at: number): void {
    k.triggerAt = k.triggerAt === null ? at : Math.min(k.triggerAt, at);
    k.followUp = true;
    this.schedule(k, Math.max(this.deps.now(), k.readAt + RUN_THROTTLE_MS));
  }

  private schedule(k: KeyState, at: number): void {
    if (k.disposed) return;
    if (k.timer !== undefined && k.dueAt <= at) return;
    this.deps.clearTimer(k.timer);
    k.timer = undefined;
    if (at <= this.deps.now()) {
      void this.read(k);
      return;
    }
    k.dueAt = at;
    k.timer = this.deps.setTimer(() => {
      k.timer = undefined;
      void this.read(k);
    }, at - this.deps.now());
  }

  private async read(k: KeyState): Promise<void> {
    if (k.disposed) return;
    if (!this.visible) {
      k.deferred = true;
      return;
    }
    if (k.inFlight) {
      k.again = true;
      return;
    }
    k.inFlight = true;
    k.again = false;
    const triggerAt = k.triggerAt;
    const followUp = k.followUp;
    k.triggerAt = null;
    k.followUp = false;
    k.readAt = this.deps.now();
    let runs: Run[] | null = null;
    try {
      runs = await this.deps.forgeRuns(k.root, k.branch);
    } catch {
      // No forge, no account, or a host error: nothing binds and nothing shows.
    }
    k.inFlight = false;
    if (k.disposed) return;
    let boundNew = false;
    if (runs !== null) boundNew = this.apply(k, runs, triggerAt ?? k.readAt);
    if (k.again) {
      void this.read(k);
      return;
    }
    if ([...k.bound.values()].some(isRunActive)) this.schedule(k, k.readAt + FAST_POLL_MS);
    else if (triggerAt !== null && followUp && !boundNew && runs !== null) {
      k.triggerAt = triggerAt;
      this.schedule(k, k.readAt + RUN_THROTTLE_MS);
    }
  }

  /** True when a new run bound to a pane. */
  private apply(k: KeyState, runs: Run[], triggerAt: number): boolean {
    const now = k.readAt;
    const prev = k.runs !== null && now - k.listAt <= STALE_LIST_MS ? k.runs : null;
    const fresh = newRuns(prev, runs, triggerAt);
    k.runs = runs;
    k.listAt = now;
    const key = keyOf(k);
    let newest: Run | null = null;
    for (const r of fresh) if (newest === null || r.createdAt > newest.createdAt) newest = r;
    const pane = newest === null ? undefined : this.panes.find((p) => this.paneKey(p) === key);
    for (const [paneId, old] of [...k.bound]) {
      if (pane && paneId === pane.paneId) continue;
      const next = runs.find((r) => r.id === old.id);
      if (!next) {
        // Aged out of the host's capped list: its finish can no longer be seen, and keeping it
        // would poll forever.
        k.bound.delete(paneId);
        continue;
      }
      k.bound.set(paneId, next);
      if (next.status !== old.status) this.deps.bind(paneId, paneRunOf(next));
      const kind = runFinish(old, next);
      if (kind !== null) this.deps.finish(paneId, kind);
    }
    if (!newest || !pane || key === null) return false;
    k.bound.set(pane.paneId, newest);
    this.shown.set(pane.paneId, key);
    this.deps.bind(pane.paneId, paneRunOf(newest));
    // A quick run (a lint step) can finish before the first read sees it.
    if (!isRunActive(newest)) {
      const kind = runFinish({ ...newest, status: 'running' }, newest);
      if (kind !== null) this.deps.finish(pane.paneId, kind);
    }
    return true;
  }
}

/** The live dependencies; `bind` and `finish` come from the workspace. */
export function livePaneRunDeps(callbacks: Pick<PaneRunDeps, 'bind' | 'finish'>): PaneRunDeps {
  return {
    forgeRuns: (root, branch) => forgeRuns(root, branch),
    onGitChanged: (cb) => {
      // The tracker lives for the whole session, so the subscription is never released.
      try {
        void Promise.resolve(onGitChanged(cb)).catch(() => {});
      } catch {
        // No Tauri runtime (a plain browser): nothing emits.
      }
    },
    gitWatch,
    gitUnwatch,
    resolve: (folder) =>
      repoRoot(folder).then((info) => {
        const home = getHomeDir();
        // A dotfiles repo at home would put a recursive watcher over the whole home folder.
        if (!info.isGit || (home !== null && samePath(info.root, home))) return null;
        return { root: info.root, branch: info.branch ?? null };
      }),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    bindVisibility: bindWindowVisibility,
    ...callbacks,
  };
}
