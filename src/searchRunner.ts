import { cancelSearch, startSearch, type SearchBatch } from './searchApi';
import type { SearchOptions } from './searchOptions';
import { applyBatch, emptyResults, withError, type SearchResults } from './searchModel';

export const SEARCH_DEBOUNCE_MS = 250;

export interface SearchRunnerDeps {
  onChange: (state: SearchResults) => void;
  start?: (root: string, query: string, options: SearchOptions, onBatch: (b: SearchBatch) => void) => Promise<number>;
  cancel?: (id: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** One pane's search lifecycle: debounces, cancels the previous search, and drops stale batches. */
export class SearchRunner {
  private readonly start: NonNullable<SearchRunnerDeps['start']>;
  private readonly cancelFn: NonNullable<SearchRunnerDeps['cancel']>;
  private readonly setTimer: NonNullable<SearchRunnerDeps['setTimer']>;
  private readonly clearTimer: NonNullable<SearchRunnerDeps['clearTimer']>;
  private readonly onChange: (state: SearchResults) => void;
  private timer: unknown = null;
  // Bumped by every run and cancel; a batch or start result from an older generation is ignored.
  private generation = 0;
  private activeId: number | null = null;
  private current: SearchResults = emptyResults();
  private disposed = false;

  constructor(deps: SearchRunnerDeps) {
    this.onChange = deps.onChange;
    this.start = deps.start ?? startSearch;
    this.cancelFn = deps.cancel ?? cancelSearch;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get results(): SearchResults {
    return this.current;
  }

  /** Runs after 250 ms of quiet; an empty query clears immediately. */
  schedule(root: string, query: string, options: SearchOptions): void {
    if (this.disposed) return;
    this.clearPending();
    if (query === '') {
      this.runNow(root, query, options);
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.runNow(root, query, options);
    }, SEARCH_DEBOUNCE_MS);
  }

  runNow(root: string, query: string, options: SearchOptions): void {
    if (this.disposed) return;
    this.clearPending();
    const gen = ++this.generation;
    this.cancelActive();
    this.current = emptyResults();
    this.onChange(this.current);
    if (query === '') return;

    this.start(root, query, options, (batch) => {
      if (gen !== this.generation || this.disposed) return;
      this.current = applyBatch(this.current, batch);
      this.onChange(this.current);
    }).then(
      (id) => {
        if (gen === this.generation && !this.disposed) this.activeId = id;
        else this.cancelFn(id).catch(() => {});
      },
      (err: unknown) => {
        if (gen !== this.generation || this.disposed) return;
        this.current = withError(this.current, errorMessage(err));
        this.onChange(this.current);
      },
    );
  }

  /** Stops the running search and any pending debounce, leaving the current results as they are. */
  cancel(): void {
    this.clearPending();
    this.generation++;
    this.cancelActive();
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private clearPending(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private cancelActive(): void {
    if (this.activeId === null) return;
    const id = this.activeId;
    this.activeId = null;
    this.cancelFn(id).catch(() => {});
  }
}

function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
