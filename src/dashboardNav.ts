import { restoreIndex, stepIndex, type NavMove } from './dashboardNavModel';

export interface DashboardNavOptions {
  /** Escape: hand focus back to the panes. */
  onLeave: () => void;
  /** A key the dashboard does not use itself; true when a workspace action handled it. */
  onKey: (e: KeyboardEvent) => boolean;
}

/** Where keyboard focus sat before the dashboard rebuilt its rows. */
export interface NavSnapshot {
  el: HTMLElement;
  key: string;
  index: number;
}

// Section headers and every row a click acts on. Layout, pin, and container rows share
// `.favorite-row`; the Repo section's buttons and the footer's are rows of their own.
const ITEM_SELECTOR = [
  '.collapsible-head',
  '.repo-button',
  '.favorite-row',
  '.recent-row',
  '.terminal-group-header',
  '.terminal-card',
  '.session-head',
  '.dashboard-footer button',
].join(', ');

/**
 * Keyboard navigation of the dashboard (docs/design.md section 4.6): arrows move between rows,
 * Enter acts as a click, and keys the dashboard does not use run as workspace actions. Rows are
 * focused only from the keyboard, since the panel keeps mouse presses from taking focus.
 */
export class DashboardNav {
  private lastKey: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: DashboardNavOptions,
  ) {
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  hasFocus(): boolean {
    return this.root.contains(document.activeElement);
  }

  /** Focuses the row focused last, else the focused pane's card, else the first row. */
  enter(): void {
    const items = this.items();
    const last = this.lastKey === null ? -1 : items.findIndex((el) => this.keyOf(el) === this.lastKey);
    const card = items.findIndex((el) => el.matches('.terminal-card.focused'));
    const at = last >= 0 ? last : card >= 0 ? card : 0;
    if (items[at]) this.focus(items[at]);
  }

  /** Records the focused row before a rebuild; null when focus is elsewhere. */
  capture(): NavSnapshot | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.root.contains(active)) return null;
    const el = active.closest<HTMLElement>(ITEM_SELECTOR);
    if (!el) return null;
    return { el: active, key: this.keyOf(el), index: this.items().indexOf(el) };
  }

  /** Refocuses the same row after a rebuild replaced the element that had focus. */
  restore(snapshot: NavSnapshot | null): void {
    if (!snapshot || snapshot.el.isConnected) return;
    const items = this.items();
    const at = restoreIndex(items.map((el) => this.keyOf(el)), snapshot.key, snapshot.index);
    if (at >= 0) this.focus(items[at]);
  }

  /** The rows on screen, top to bottom; rows in collapsed or hidden sections are left out. */
  private items(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
      (el) => el.getClientRects().length > 0,
    );
  }

  /** A key that survives a rebuild of the row's element. */
  private keyOf(el: HTMLElement): string {
    if (el.dataset.paneId) return `pane:${el.dataset.paneId}`;
    if (el.dataset.tabId) return `tab:${el.dataset.tabId}`;
    const session = el.closest<HTMLElement>('[data-session-id]');
    if (session) return `session:${session.dataset.sessionId}`;
    const section = el.closest<HTMLElement>('[data-section]')?.dataset.section ?? 'footer';
    if (el.matches('.collapsible-head')) return `head:${section}`;
    const scope = el.closest<HTMLElement>('[data-section], .dashboard-footer') ?? this.root;
    const peers = [...scope.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
      (p) => !p.matches('.collapsible-head'),
    );
    return `${section}:${peers.indexOf(el)}`;
  }

  private focus(el: HTMLElement): void {
    if (!(el instanceof HTMLButtonElement)) el.tabIndex = -1;
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
    this.lastKey = this.keyOf(el);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    // Rename and layout-name fields own their keys.
    if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    if (this.navigate(e, t) || this.opts.onKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private navigate(e: KeyboardEvent, target: HTMLElement): boolean {
    if (e.altKey || e.metaKey || e.shiftKey) return false;
    const item = target.closest<HTMLElement>(ITEM_SELECTOR);
    if (e.ctrlKey) {
      if (e.key !== 'Enter' || !item || target !== item) return false;
      this.click(item, true);
      return true;
    }
    switch (e.key) {
      case 'Escape':
        this.opts.onLeave();
        return true;
      case 'ArrowDown':
        return this.move(item, 'next');
      case 'ArrowUp':
        return this.move(item, 'prev');
      case 'Home':
        return this.move(item, 'first');
      case 'End':
        return this.move(item, 'last');
      case 'ArrowLeft':
        return item ? this.left(item) : false;
      case 'ArrowRight':
        return item ? this.right(item) : false;
      case 'Enter':
      case ' ':
        // Buttons, including those inside a row, keep their native Enter and Space.
        if (!item || target !== item || item instanceof HTMLButtonElement) return false;
        this.click(item, false);
        return true;
      default:
        return false;
    }
  }

  private move(from: HTMLElement | null, move: NavMove): boolean {
    const items = this.items();
    const at = stepIndex(items.length, from ? items.indexOf(from) : -1, move);
    if (at >= 0) this.focus(items[at]);
    return true;
  }

  /** On a row, goes to its section's header; on an expanded header, collapses the section. */
  private left(item: HTMLElement): boolean {
    const section = item.closest<HTMLElement>('[data-section]');
    if (!section) return true;
    if (!item.matches('.collapsible-head')) {
      const head = section.querySelector<HTMLElement>('.collapsible-head');
      if (head) this.focus(head);
    } else if (!section.classList.contains('collapsed')) {
      this.click(item, false);
    }
    return true;
  }

  /** On a collapsed header, expands the section; on an expanded one, goes to its first row. */
  private right(item: HTMLElement): boolean {
    if (!item.matches('.collapsible-head')) return true;
    if (item.closest('[data-section]')?.classList.contains('collapsed')) this.click(item, false);
    else this.move(item, 'next');
    return true;
  }

  /** Acts as a click on the row itself, so a row's own click handler decides what happens. */
  private click(item: HTMLElement, ctrlKey: boolean): void {
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey, detail: 1 }));
  }
}
