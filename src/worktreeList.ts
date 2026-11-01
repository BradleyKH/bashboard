import { samePath } from './favorites';
import type { OpenInHandler } from './openMenu';
import {
  gitWorktreeDetail,
  type Worktree,
  type WorktreeDetail,
  type WorktreeList as WorktreeListData,
} from './worktreeApi';
import { renderWorktreeDetail } from './worktreeDetail';
import { renderWorktreeRow } from './worktreeRow';

export interface WorktreesState {
  /** The main worktree's path. */
  root: string;
  list: WorktreeListData;
  focusedPath: string | null;
  error?: string;
}

export interface WorktreeCallbacks {
  onOpenIn: OpenInHandler;
  /** Resolves to a message to show inline, or null when it succeeded or was cancelled. */
  onDeleteWorktree(root: string, w: Worktree): Promise<string | null>;
  onSetPrimaryBranch(root: string, branch: string | null): void;
}

interface Expanded {
  path: string;
  /** The row's data the detail was loaded for; a change reloads it. */
  key: string;
  detail: WorktreeDetail | null;
  loading: boolean;
  error?: string;
  message?: string;
  deleting: boolean;
}

interface FocusSpot {
  path: string;
  region: 'row' | 'detail';
  button: number;
}

/** The Repo section's worktree rows, one of them expanded into its detail (docs/v0.2.0-design.md sections 4.1 and 4.2). */
export class WorktreeList {
  readonly el: HTMLElement;
  private state: WorktreesState | null = null;
  private expanded: Expanded | null = null;

  constructor(private readonly callbacks: WorktreeCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'dashboard-list worktree-list';
    this.el.hidden = true;
  }

  /** Whether the list is on screen (a repo with two or more worktrees). */
  get shown(): boolean {
    return !this.el.hidden;
  }

  update(state: WorktreesState | null): void {
    this.state = state;
    const e = this.expanded;
    if (e) {
      const w = this.find(e.path);
      if (!w) this.expanded = null;
      else if (JSON.stringify(w) !== e.key) this.load(w, true);
    }
    this.render();
  }

  private find(path: string): Worktree | undefined {
    return this.state?.list.worktrees.find((w) => samePath(w.path, path));
  }

  private toggle(w: Worktree): void {
    if (this.expanded && samePath(this.expanded.path, w.path)) this.expanded = null;
    else this.load(w, false);
    this.render();
  }

  /** Loads the detail for `w`; a refresh keeps the shown detail and message while it loads. */
  private load(w: Worktree, refresh: boolean): void {
    const prev = refresh ? this.expanded : null;
    const e: Expanded = {
      path: w.path,
      key: JSON.stringify(w),
      detail: prev?.detail ?? null,
      loading: !w.prunable,
      message: prev?.message,
      deleting: prev?.deleting ?? false,
    };
    this.expanded = e;
    if (w.prunable) return;
    gitWorktreeDetail(w.path).then(
      (detail) => {
        if (this.expanded !== e) return;
        e.detail = detail;
        e.error = undefined;
        e.loading = false;
        this.render();
      },
      (err: unknown) => {
        if (this.expanded !== e) return;
        e.error = String(err);
        e.loading = false;
        this.render();
      },
    );
  }

  private delete(w: Worktree): void {
    const state = this.state;
    const e = this.expanded;
    if (!state || !e || e.deleting) return;
    e.deleting = true;
    e.message = undefined;
    this.render();
    this.callbacks.onDeleteWorktree(state.root, w).then(
      (message) => this.deleteDone(w.path, message),
      (err: unknown) => this.deleteDone(w.path, String(err)),
    );
  }

  /** The row menu's Delete expands the row first so the detail shows the progress and any refusal. */
  private deleteFromRow(w: Worktree): void {
    if (!this.expanded || !samePath(this.expanded.path, w.path)) this.load(w, false);
    this.delete(w);
  }

  private deleteDone(path: string, message: string | null): void {
    const e = this.expanded;
    if (!e || !samePath(e.path, path)) return;
    e.deleting = false;
    // On success the reload that follows removes the row.
    if (message === null) this.expanded = null;
    else e.message = message;
    this.render();
  }

  private render(): void {
    const state = this.state;
    const worktrees = state?.list.worktrees ?? [];
    this.el.hidden = worktrees.length < 2;
    if (this.el.hidden || !state) {
      this.el.replaceChildren();
      return;
    }
    const focus = this.captureFocus();
    const items: HTMLElement[] = [];
    if (state.error) {
      const err = document.createElement('div');
      err.className = 'worktree-message';
      err.textContent = state.error;
      items.push(err);
    }
    for (const w of worktrees) {
      const e = this.expanded && samePath(this.expanded.path, w.path) ? this.expanded : null;
      const item = document.createElement('div');
      item.className = 'worktree-item';
      item.append(
        renderWorktreeRow(w, {
          focused: state.focusedPath !== null && samePath(state.focusedPath, w.path),
          expanded: e !== null,
          onToggle: () => this.toggle(w),
          onOpenIn: this.callbacks.onOpenIn,
          onDelete: () => this.deleteFromRow(w),
        }),
      );
      if (e) {
        item.append(
          renderWorktreeDetail(w, e.detail, {
            loading: e.loading,
            error: e.error,
            message: e.deleting ? 'Deleting...' : e.message,
            onOpenIn: this.callbacks.onOpenIn,
            onDelete: () => this.delete(w),
          }),
        );
      }
      items.push(item);
    }
    this.el.replaceChildren(...items);
    this.restoreFocus(focus);
  }

  /** The focused control inside a row or its detail, by worktree path, region, and button index, so a rebuild keeps keyboard focus. */
  private captureFocus(): FocusSpot | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.el.contains(active)) return null;
    const item = active.closest<HTMLElement>('.worktree-item');
    const path = item?.querySelector<HTMLElement>('.worktree-row')?.dataset.worktreePath;
    if (!item || !path) return null;
    const region = item.querySelector('.worktree-detail')?.contains(active) ? 'detail' : 'row';
    return { path, region, button: [...item.querySelectorAll(`.worktree-${region} button`)].indexOf(active) };
  }

  private restoreFocus(focus: FocusSpot | null): void {
    if (!focus) return;
    const row = [...this.el.querySelectorAll<HTMLElement>('.worktree-row')].find(
      (r) => r.dataset.worktreePath !== undefined && samePath(r.dataset.worktreePath, focus.path),
    );
    if (!row) return;
    const buttons = row.parentElement?.querySelectorAll<HTMLButtonElement>(`.worktree-${focus.region} button`);
    const target = (focus.button >= 0 && buttons?.[focus.button]) || row;
    if (target === row) row.tabIndex = -1;
    target.focus();
  }
}
