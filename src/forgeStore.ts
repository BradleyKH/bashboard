import {
  asForgeError,
  forgeCancel,
  forgeJobs,
  forgeLog,
  forgePullChecks,
  forgePulls,
  forgeRepo,
  forgeRerun,
  forgeRuns,
  forgeSetAccount,
  type ForgeError,
  type ForgeRepo,
  type Job,
  type JobLog,
  type PullRequest,
  type Run,
} from './forgeApi';
import { finishedSince, pollSecs, pullPollSecs, withPullChecks, type ForgeTab } from './forgeModel';
import { isWindowVisible } from './windowVisibility';

export type BranchScope = 'branch' | 'all';

type Stream = 'runs' | 'pulls';

/** Poll spacing before the repo (and so the host's minimum) is known, and after a failure. */
const FALLBACK_SECS = 60;
/** After a re-run or cancel the run list moves quickly, so look again soon. */
const AFTER_ACTION_MS = 3000;

interface Entry {
  store: ForgeStore;
  refs: number;
}

/**
 * One repo's runs and pull requests, shared by every Forge pane on that root (docs/design.md
 * section 4.20). Runs poll while some pane wants the store, pull requests only while one of them is
 * on the Pull requests tab, and both pause while the window is hidden and catch up when it returns.
 */
export class ForgeStore {
  private static readonly registry = new Map<string, Entry>();

  /** The store for `root`, created on first use. Each caller must `release()` it once. */
  static for(root: string): ForgeStore {
    let entry = ForgeStore.registry.get(root);
    if (!entry) {
      entry = { store: new ForgeStore(root), refs: 0 };
      ForgeStore.registry.set(root, entry);
    }
    entry.refs += 1;
    return entry.store;
  }

  /** Whether some pane already holds the store for `root`. */
  static has(root: string): boolean {
    return ForgeStore.registry.has(root);
  }

  /** Drops one reference; the last one stops polling and forgets the store. */
  release(): void {
    const entry = ForgeStore.registry.get(this.root);
    if (!entry || entry.store !== this) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    ForgeStore.registry.delete(this.root);
    this.dispose();
  }

  private repoValue: ForgeRepo | null = null;
  private runList: Run[] = [];
  private runsLoaded = false;
  private pullList: PullRequest[] = [];
  private pullTotal: number | null = null;
  private pullsLoaded = false;
  private openOnly = true;
  // Bumped when the open-only filter changes, so a reply to the other question is dropped.
  private pullsEpoch = 0;
  private pullsStale = false;
  private scope: BranchScope = 'all';
  private readonly errors: Record<'repo' | Stream, ForgeError | null> = { repo: null, runs: null, pulls: null };

  private readonly subscribers = new Set<() => void>();
  private readonly finishedSubscribers = new Set<(runs: Run[]) => void>();
  private readonly wanted = new Map<string, ForgeTab>();
  private readonly timers: Record<Stream, ReturnType<typeof setTimeout> | undefined> = {
    runs: undefined,
    pulls: undefined,
  };
  private readonly inFlight: Record<Stream, boolean> = { runs: false, pulls: false };
  // Bumped when the scope, branch, or account changes, so a reply to an older question is dropped.
  private runsEpoch = 0;
  // Set when a reply still in flight is now for the wrong question, so the poll that finishes asks again.
  private runsStale = false;
  private nextRunsDelayMs: number | null = null;
  private disposed = false;
  private readonly onVisibility = (): void => {
    if (!this.visible()) return;
    // Back on screen: look at once rather than waiting out a timer that was skipped.
    for (const stream of this.activeStreams()) void this.poll(stream);
  };

  private constructor(readonly root: string) {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get repo(): ForgeRepo | null {
    return this.repoValue;
  }

  get runs(): Run[] {
    return this.runList;
  }

  /** False until the first run poll answers for the current scope. */
  get runsReady(): boolean {
    return this.runsLoaded;
  }

  get pulls(): PullRequest[] {
    return this.pullList;
  }

  /** The host's count of the pull requests asked for, or null when it does not say. */
  get pullsTotal(): number | null {
    return this.pullTotal;
  }

  /** False until the first pull request poll answers. */
  get pullsReady(): boolean {
    return this.pullsLoaded;
  }

  get branchScope(): BranchScope {
    return this.scope;
  }

  /** Whether Pull requests lists open ones only, rather than the latest in every state. */
  get pullsOpenOnly(): boolean {
    return this.openOnly;
  }

  /** The error that stops `tab` from showing anything: the repo's own, else that tab's last one. */
  errorFor(tab: ForgeTab): ForgeError | null {
    return this.errors.repo ?? this.errors[tab === 'pipelines' ? 'runs' : 'pulls'];
  }

  /** The latest error of any kind, repo first. */
  get error(): ForgeError | null {
    return this.errors.repo ?? this.errors.runs ?? this.errors.pulls;
  }

  /** Does not call back immediately. Fires on any change to what the getters return. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** Fires with the runs that went from queued or running to done; never for a first load. */
  onFinished(cb: (runs: Run[]) => void): () => void {
    this.finishedSubscribers.add(cb);
    return () => this.finishedSubscribers.delete(cb);
  }

  /**
   * Each pane turns its own `key` on and off and says which tab it shows; run polling runs while
   * any key is on, pull request polling while any key is on the Pull requests tab.
   */
  setWanted(key: string, wanted: boolean, tab: ForgeTab = 'pipelines'): void {
    const before = this.activeStreams();
    if (wanted) this.wanted.set(key, tab);
    else this.wanted.delete(key);
    const after = this.activeStreams();
    for (const stream of after) {
      if (!before.includes(stream)) void this.poll(stream);
    }
    for (const stream of before) {
      if (!after.includes(stream)) this.cancelTimer(stream);
    }
  }

  /** Polls everything wanted now, as after a Retry, rather than waiting out the interval. */
  async refresh(): Promise<void> {
    await Promise.all(this.activeStreams().map((stream) => this.poll(stream)));
  }

  async setBranchScope(scope: BranchScope): Promise<void> {
    if (scope === this.scope) return;
    this.scope = scope;
    this.resetRuns();
    this.emit();
    await this.poll('runs');
  }

  async setPullsOpenOnly(on: boolean): Promise<void> {
    if (on === this.openOnly) return;
    this.openOnly = on;
    this.resetPulls();
    this.emit();
    await this.poll('pulls');
  }

  /** Sets the repo's account, then reloads everything under it. */
  async setAccount(user: string): Promise<void> {
    this.repoValue = await forgeSetAccount(this.root, user);
    this.errors.repo = null;
    this.errors.runs = null;
    this.errors.pulls = null;
    this.resetRuns();
    this.resetPulls();
    this.emit();
    await this.refresh();
  }

  async rerun(runId: string, failedOnly: boolean): Promise<void> {
    await forgeRerun(this.root, runId, failedOnly);
    this.nextRunsDelayMs = AFTER_ACTION_MS;
    await this.poll('runs');
  }

  async cancel(runId: string): Promise<void> {
    await forgeCancel(this.root, runId);
    this.nextRunsDelayMs = AFTER_ACTION_MS;
    await this.poll('runs');
  }

  jobs(runId: string): Promise<Job[]> {
    return forgeJobs(this.root, runId);
  }

  log(runId: string, jobId: string): Promise<JobLog> {
    return forgeLog(this.root, runId, jobId);
  }

  private visible(): boolean {
    return isWindowVisible(document.visibilityState === 'visible', false);
  }

  private activeStreams(): Stream[] {
    if (this.disposed || this.wanted.size === 0) return [];
    const streams: Stream[] = ['runs'];
    if ([...this.wanted.values()].includes('pulls')) streams.push('pulls');
    return streams;
  }

  private emit(): void {
    for (const cb of [...this.subscribers]) cb();
  }

  private cancelTimer(stream: Stream): void {
    clearTimeout(this.timers[stream]);
    this.timers[stream] = undefined;
  }

  private resetRuns(): void {
    this.runsEpoch += 1;
    this.runsStale = this.inFlight.runs;
    this.runList = [];
    this.runsLoaded = false;
  }

  private resetPulls(): void {
    this.pullsEpoch += 1;
    this.pullsStale = this.inFlight.pulls;
    this.pullList = [];
    this.pullTotal = null;
    this.pullsLoaded = false;
  }

  private dispose(): void {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.cancelTimer('runs');
    this.cancelTimer('pulls');
    this.subscribers.clear();
    this.finishedSubscribers.clear();
  }

  private schedule(stream: Stream, delayMs: number): void {
    this.cancelTimer(stream);
    if (!this.activeStreams().includes(stream)) return;
    this.timers[stream] = setTimeout(() => {
      this.timers[stream] = undefined;
      // A hidden window skips the poll; the visibility listener polls when it comes back.
      if (this.visible()) void this.poll(stream);
    }, delayMs);
  }

  /** The delay to the next poll of `stream`: its own cadence, or what a rate limit asked for. */
  private nextDelayMs(stream: Stream, err: ForgeError | null): number {
    if (err?.kind === 'rateLimited') return Math.max(err.retryAfterSecs ?? FALLBACK_SECS, 1) * 1000;
    const caps = this.repoValue?.capabilities;
    if (err || !caps) return FALLBACK_SECS * 1000;
    if (stream === 'runs') {
      const forced = this.nextRunsDelayMs;
      this.nextRunsDelayMs = null;
      return forced ?? pollSecs(caps, this.runList) * 1000;
    }
    return pullPollSecs(caps) * 1000;
  }

  private async poll(stream: Stream): Promise<void> {
    if (this.disposed || this.inFlight[stream]) return;
    if (!this.activeStreams().includes(stream)) return;
    this.inFlight[stream] = true;
    this.cancelTimer(stream);
    if (stream === 'runs') this.runsStale = false;
    else this.pullsStale = false;
    let err: ForgeError | null = null;
    try {
      if (stream === 'runs') await this.pollRuns();
      else await this.pollPulls();
    } catch (e) {
      err = asForgeError(e);
      this.errors[stream] = err;
      this.emit();
    } finally {
      this.inFlight[stream] = false;
    }
    if (this.disposed) return;
    if (stream === 'runs' ? this.runsStale : this.pullsStale) {
      void this.poll(stream);
      return;
    }
    this.schedule(stream, this.nextDelayMs(stream, err));
  }

  /** Resolves the repo again (the Rust side caches it briefly) so the branch follows a checkout. */
  private async loadRepo(): Promise<ForgeRepo> {
    try {
      const repo = await forgeRepo(this.root);
      this.errors.repo = null;
      return repo;
    } catch (e) {
      this.errors.repo = asForgeError(e);
      this.emit();
      throw e;
    }
  }

  private async pollRuns(): Promise<void> {
    const before = this.repoValue?.branch ?? null;
    const repo = await this.loadRepo();
    this.repoValue = repo;
    if (this.scope === 'branch' && this.runsLoaded && before !== repo.branch) {
      // A checkout changed what "this branch" means, so the old list answers another question.
      this.resetRuns();
      this.runsStale = false;
      this.emit();
    }
    const epoch = this.runsEpoch;
    const next = await forgeRuns(this.root, this.scope === 'branch' ? repo.branch : null);
    if (epoch !== this.runsEpoch || this.disposed) return;
    const done = finishedSince(this.runsLoaded ? this.runList : undefined, next);
    this.runList = next;
    this.runsLoaded = true;
    this.errors.runs = null;
    this.emit();
    if (done.length > 0) for (const cb of [...this.finishedSubscribers]) cb(done);
  }

  private async pollPulls(): Promise<void> {
    if (!this.repoValue) this.repoValue = await this.loadRepo();
    const epoch = this.pullsEpoch;
    const next = await forgePulls(this.root, this.openOnly);
    if (epoch !== this.pullsEpoch || this.disposed) return;
    this.pullList = next.items;
    this.pullTotal = next.total;
    this.pullsLoaded = true;
    this.errors.pulls = null;
    this.emit();
    await this.fillPullChecks(epoch);
  }

  /**
   * Fetches the checks the list left pending and merges them in, so the rows show first and
   * their status icons arrive after. Still inside the poll, so the next one waits for it.
   */
  private async fillPullChecks(epoch: number): Promise<void> {
    const pending = this.pullList.filter((p) => p.checksPending);
    if (pending.length === 0) return;
    let found: Awaited<ReturnType<typeof forgePullChecks>> = [];
    try {
      found = await forgePullChecks(this.root, pending);
    } catch {
      // The rows keep showing; they lose only the pending mark, and the next poll asks again.
    }
    if (epoch !== this.pullsEpoch || this.disposed) return;
    this.pullList = withPullChecks(this.pullList, found);
    this.emit();
  }
}
