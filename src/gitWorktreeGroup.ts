import './gitWorktrees.css';
import { openBranchMenu } from './branchMenu';
import type { MenuEntry } from './contextMenuModel';
import { copyPath } from './copyText';
import { displayPath } from './displayPath';
import { samePath } from './favorites';
import { openFolder } from './folderButton';
import { openInItems, openInMenuItems, openMenuButton, type OpenInHandler } from './openMenu';
import { worktreeRowMenuItems } from './repoMenus';
import { gitWorktreeDetail, type Worktree, type WorktreeDetail, type WorktreeList } from './worktreeApi';
import { renderWorktreeDetail } from './worktreeDetail';
import { compareLabel, countsText, filterWorktrees, worktreeBadge } from './worktreeModel';

export interface GitWorktreeGroupOptions {
  onOpenIn: OpenInHandler;
  /** Resolves to a message to show inline, or null when it was removed or cancelled. */
  onDelete(w: Worktree): Promise<string | null>;
  onSetPrimaryBranch(branch: string | null): void;
  /** Something the group draws changed; the Branches view renders again. */
  onChange(): void;
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

/** A row's key in the Branches view's listbox. */
export function worktreeKey(path: string): string {
  return `worktree:${path}`;
}

function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

function span(className: string, text: string, title?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  if (title !== undefined) el.title = title;
  return el;
}

/**
 * The Branches tab's Worktrees group (docs/design/git.md section 4.13): every worktree of the repo,
 * compared with the primary branch, one row at a time expanded into its detail. Shown while the
 * repo has two or more worktrees.
 */
export class GitWorktreeGroup {
  private list: WorktreeList | null = null;
  private error: string | null = null;
  /** The pane's own worktree, marked as current. */
  private here = '';
  private open = true;
  private expanded: Expanded | null = null;

  constructor(private readonly opts: GitWorktreeGroupOptions) {}

  /** A null list keeps the last good one on screen under `error`. */
  set(list: WorktreeList | null, error: string | null, here: string): void {
    if (list !== null) this.list = list;
    this.error = error;
    this.here = here;
    const e = this.expanded;
    if (e) {
      const w = this.find(e.path);
      if (!w) this.expanded = null;
      else if (JSON.stringify(w) !== e.key) this.load(w, true);
    }
  }

  find(path: string): Worktree | undefined {
    return this.list?.worktrees.find((w) => samePath(w.path, path));
  }

  /** The keyed path of a listbox row key, or null when the key is not a worktree's. */
  static pathOf(key: string): string | null {
    return key.startsWith('worktree:') ? key.slice(9) : null;
  }

  toggle(w: Worktree): void {
    if (this.expanded && samePath(this.expanded.path, w.path)) this.expanded = null;
    else this.load(w, false);
    this.opts.onChange();
  }

  /** Expands the row first, so its detail shows the progress and any refusal. */
  delete(w: Worktree): void {
    if (w.main || w.locked) return;
    if (!this.expanded || !samePath(this.expanded.path, w.path)) this.load(w, false);
    const e = this.expanded;
    if (!e || e.deleting) return;
    e.deleting = true;
    e.message = undefined;
    this.opts.onChange();
    this.opts.onDelete(w).then(
      (message) => this.deleteDone(w.path, message),
      (err: unknown) => this.deleteDone(w.path, String(err)),
    );
  }

  /** The context menu for a row; a missing folder keeps only Delete. */
  async menuEntries(w: Worktree): Promise<MenuEntry[]> {
    const openItems = w.prunable
      ? openInItems(w.path, false, this.opts.onOpenIn)
      : await openInMenuItems(w.path, this.opts.onOpenIn);
    return worktreeRowMenuItems({ missing: w.prunable, locked: w.locked }, openItems, {
      openInExplorer: () => openFolder(w.path),
      copyPath: () => void copyPath(w.path),
      delete: w.main ? undefined : () => this.delete(w),
    });
  }

  /**
   * The header and rows for the Branches view, filtered by `query`; empty for fewer than two
   * worktrees. `row` wraps each row in the view's selectable row shell.
   */
  render(
    query: string,
    filtering: boolean,
    head: (open: boolean, count: number) => HTMLElement,
    row: (key: string) => HTMLElement,
  ): HTMLElement[] {
    const list = this.list;
    if (!list || list.worktrees.length < 2) return [];
    const shown = filterWorktrees(list.worktrees, query);
    // A filter searches worktrees too, so the group opens while one is typed.
    const open = this.open || filtering;
    const h = head(open, shown.length);
    h.addEventListener('click', () => {
      this.open = !this.open;
      this.opts.onChange();
    });
    h.append(this.compareButton(list));
    const out: HTMLElement[] = [h];
    if (!open) return out;
    if (this.error) out.push(span('git-empty worktree-message', this.error));
    if (shown.length === 0) out.push(span('git-empty', 'No worktree matches'));
    for (const w of shown) {
      out.push(this.row(w, row(worktreeKey(w.path))));
      const e = this.expanded && samePath(this.expanded.path, w.path) ? this.expanded : null;
      if (e) {
        out.push(
          renderWorktreeDetail(w, e.detail, {
            loading: e.loading,
            error: e.error,
            message: e.deleting ? 'Deleting...' : e.message,
          }),
        );
      }
    }
    return out;
  }

  private compareButton(list: WorktreeList): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'git-section-btn worktree-compare';
    b.textContent = `${compareLabel(list.primary)} ▾`;
    b.title = 'The branch worktrees are compared with';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const configured = list.primary.configured;
      const pick = (branch: string | null) => () => this.opts.onSetPrimaryBranch(branch);
      openBranchMenu(b, [
        {
          label: !configured && list.primary.branch ? `Automatic (${list.primary.branch})` : 'Automatic',
          checked: !configured,
          onPick: pick(null),
        },
        ...list.localBranches.map((name) => ({ label: name, checked: name === configured, onPick: pick(name) })),
      ]);
    });
    return b;
  }

  private row(w: Worktree, el: HTMLElement): HTMLElement {
    el.classList.add('worktree-item');
    el.classList.toggle('current', samePath(w.path, this.here));
    el.classList.toggle('missing', w.prunable);
    el.classList.toggle('expanded', this.expanded !== null && samePath(this.expanded.path, w.path));
    el.setAttribute('aria-expanded', String(el.classList.contains('expanded')));
    el.addEventListener('click', () => this.toggle(w));

    el.append(span('git-row-path git-branch-label', folderName(w.path), displayPath(w.path)));
    const branch = span('git-branch-track worktree-branch', w.branch ?? w.head?.slice(0, 7) ?? '');
    if (!w.branch) branch.classList.add('detached');
    el.append(branch);
    const counts = countsText(w.ahead, w.behind);
    const against = this.list?.primary.comparison;
    if (counts) el.append(span('git-branch-track', counts, against ? `Against ${against}` : undefined));
    const badge = worktreeBadge(w);
    if (badge) {
      const pill = span('worktree-badge', badge, badge === 'Locked' && w.lockReason ? w.lockReason : undefined);
      pill.dataset.badge = badge.toLowerCase().replace(/ /g, '-');
      el.append(pill);
    }

    const actions = document.createElement('span');
    actions.className = 'git-row-actions';
    // A missing folder has nothing to open.
    if (!w.prunable) {
      const open = openMenuButton(w.path, this.opts.onOpenIn);
      open.className = 'git-row-btn';
      open.textContent = 'Open ▾';
      actions.append(open);
    }
    if (!w.main) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'git-row-btn';
      del.textContent = 'Delete';
      del.title = w.locked ? (w.lockReason ? `Locked: ${w.lockReason}` : 'The worktree is locked') : 'Delete the worktree (Del)';
      del.disabled = w.locked;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.delete(w);
      });
      actions.append(del);
    }
    el.append(actions);
    return el;
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
        this.opts.onChange();
      },
      (err: unknown) => {
        if (this.expanded !== e) return;
        e.error = String(err);
        e.loading = false;
        this.opts.onChange();
      },
    );
  }

  private deleteDone(path: string, message: string | null): void {
    const e = this.expanded;
    if (!e || !samePath(e.path, path)) return;
    e.deleting = false;
    // On success the reload that follows removes the row.
    if (message === null) this.expanded = null;
    else e.message = message;
    this.opts.onChange();
  }
}
