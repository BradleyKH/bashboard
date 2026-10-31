import { gitUnwatch, gitWatch } from './gitApi';
import { samePath } from './favorites';
import { gitWorktrees, type WorktreeList } from './worktreeApi';
import { isRepoRoot } from './worktreeModel';

/** Owns the shown repo's worktree list (docs/design.md section 4.6). It never polls; reloads come from `git://changed` and explicit calls. */
export class WorktreeStore {
  private shown: string | null = null;
  private list: WorktreeList | null = null;
  private err: string | null = null;
  private loading = false;
  private queued = false;
  private watched: string | null = null;

  constructor(private readonly onChange: () => void) {}

  show(root: string | null): void {
    if (root === this.shown) return;
    this.releaseWatch();
    this.shown = root;
    this.list = null;
    this.err = null;
    this.queued = false;
    this.onChange();
    if (root) void this.load();
  }

  reload(): void {
    if (this.shown) void this.load();
  }

  /** `root` is the main worktree's path once loaded (it holds the common dir); the shown root before that. */
  current(): { root: string; list: WorktreeList } | null {
    if (!this.shown || !this.list) return null;
    return { root: this.list.worktrees[0]?.path ?? this.shown, list: this.list };
  }

  error(): string | null {
    return this.err;
  }

  handleGitChanged(root: string, metadata: boolean): void {
    if (!metadata || !this.shown) return;
    if (samePath(root, this.shown) || (this.list && isRepoRoot(root, this.list.worktrees))) {
      void this.load();
    }
  }

  private async load(): Promise<void> {
    // Each load runs a rev-list per worktree, so a trigger during a load queues exactly one more.
    if (this.loading) {
      this.queued = true;
      return;
    }
    const root = this.shown;
    if (!root) return;
    this.loading = true;
    try {
      const list = await gitWorktrees(root);
      if (this.shown === root) {
        this.list = list;
        this.err = null;
        this.acquireWatch(list.worktrees[0]?.path ?? root);
      }
    } catch (e) {
      if (this.shown === root) {
        this.list = null;
        this.err = String(e);
      }
    } finally {
      this.loading = false;
      if (this.shown === root) this.onChange();
    }
    if (this.queued) {
      this.queued = false;
      if (this.shown) void this.load();
    }
  }

  private acquireWatch(path: string): void {
    if (this.watched && samePath(this.watched, path)) return;
    this.releaseWatch();
    this.watched = path;
    // A failed watch is ignored; the other reload triggers still work.
    gitWatch(path).catch(() => {});
  }

  private releaseWatch(): void {
    if (!this.watched) return;
    const path = this.watched;
    this.watched = null;
    gitUnwatch(path).catch(() => {});
  }
}
