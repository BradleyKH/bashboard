// shipPane.css carries the status icon classes; the dashboard can render before any Ship pane exists.
import './shipPane.css';
import './branchSection.css';
import type { ShipTab } from './shipModel';
import {
  branchSectionView,
  sameView,
  type BranchRow,
  type BranchSectionState,
  type BranchSectionView,
} from './branchSectionModel';

export interface BranchSectionOptions {
  /** Open the Git tab for this worktree. */
  onOpenGit(worktree: string): void;
  /** Open the Ship tab for this worktree, on its pull requests for `tab` 'pulls'. */
  onOpenShip(worktree: string, tab?: ShipTab): void;
}

/** The dashboard's Branch section: the followed folder's branch size, position, dirt, CI, and pull request. */
export class BranchSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly folderEl: HTMLElement;
  private readonly link: HTMLButtonElement;
  private readonly list: HTMLElement;
  private worktree = '';
  private shown: BranchSectionView | null = null;

  constructor(private readonly options: BranchSectionOptions) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section branch-section';
    this.el.hidden = true;

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Branch';

    // A button, so a click opens the Git tab instead of collapsing the section (makeCollapsible skips buttons).
    this.link = document.createElement('button');
    this.link.type = 'button';
    this.link.className = 'branch-section-link';
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'branch-section-name';
    this.folderEl = document.createElement('span');
    this.folderEl.className = 'branch-section-folder';
    this.link.append(this.nameEl, this.folderEl);
    this.link.addEventListener('click', () => this.options.onOpenGit(this.worktree));
    this.head.append(h, this.link);

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
  }

  update(state: BranchSectionState): void {
    const view = branchSectionView(state);
    if (sameView(view, this.shown)) return;
    this.shown = view;
    if (view === null || state.kind === 'none') {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    this.worktree = state.worktree;
    this.nameEl.textContent = view.name;
    this.folderEl.textContent = view.folder;
    this.link.title = `${view.title}\nOpen the Git tab`;
    this.list.replaceChildren(...view.rows.map((r) => this.renderRow(r)));
  }

  private renderRow(row: BranchRow): HTMLElement {
    const el = document.createElement('div');
    if (row.kind === 'meter') {
      el.className = 'branch-row branch-meter';
      el.title = row.title;
      el.classList.toggle('over', row.over);
      if (row.fraction !== null) {
        const track = document.createElement('div');
        track.className = 'branch-meter-track';
        const fill = document.createElement('div');
        fill.className = 'branch-meter-fill';
        fill.style.width = `${Math.round(row.fraction * 100)}%`;
        track.append(fill);
        el.append(track);
      }
      const text = document.createElement('div');
      text.className = 'branch-row-text';
      text.textContent = row.text;
      el.append(text);
      return el;
    }
    if (row.kind === 'text') {
      el.className = row.tone === 'normal' ? 'branch-row' : `branch-row ${row.tone}`;
      el.textContent = row.text;
      return el;
    }
    if (row.kind === 'pull') {
      el.className = `favorite-row branch-ci-row branch-pull-row${row.done ? ' done' : ''}`;
      el.title = row.title;
      const text = document.createElement('span');
      text.className = 'branch-ci-text';
      text.textContent = row.label;
      el.append(text);
      if (row.badge !== null) {
        const badge = document.createElement('span');
        // Draft, merged, and closed take the Ship list's badge; a review decision its colored text.
        badge.className =
          row.tone === 'draft' || row.tone === 'merged' || row.tone === 'closed'
            ? `ship-badge ship-badge--${row.tone}`
            : `ship-review ship-review--${row.tone}`;
        badge.textContent = row.badge;
        el.append(badge);
      }
      el.addEventListener('click', () => this.options.onOpenShip(this.worktree, 'pulls'));
      return el;
    }
    el.className = 'favorite-row branch-ci-row';
    el.title = row.title;
    const icon = document.createElement('span');
    icon.className = `ship-status ship-status--${row.status}`;
    const text = document.createElement('span');
    text.className = 'branch-ci-text';
    text.textContent = row.label;
    el.append(icon, text);
    el.addEventListener('click', () => this.options.onOpenShip(this.worktree));
    return el;
  }
}
