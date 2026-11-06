import { ShipAddRepo } from './shipAddRepo';
import { ShipOverviewRow, type OverviewRowHandlers } from './shipOverviewRow';
import { shipOverviewStore } from './shipOverviewStore';
import { bitbucketSlowedText, updatedText } from './shipOverviewText';

/** The ages and the Updated line tick at this pace while the view is wanted. */
const TICK_MS = 30_000;

let nextId = 1;

/** The Ship pane's Overview view: one row per pinned repo in attention order (docs/design.md section 4.20). */
export class ShipOverview {
  readonly el: HTMLElement;
  private readonly key = `overview:${nextId++}`;
  private readonly rows = new Map<string, ShipOverviewRow>();
  private readonly updated: HTMLElement;
  private readonly slowed: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly addRepo = new ShipAddRepo();
  private readonly addButton: HTMLButtonElement;
  /** Whether the Add box shows while repos are pinned; with none pinned it always shows. */
  private addOpen = false;
  private readonly unsubscribe: () => void;
  private tick: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly handlers: OverviewRowHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'ship-overview';

    const bar = document.createElement('div');
    bar.className = 'ship-ov-bar';
    this.updated = document.createElement('span');
    this.updated.className = 'ship-ov-updated';
    this.slowed = document.createElement('span');
    this.slowed.className = 'ship-ov-slowed';
    this.slowed.title = 'Bitbucket repos refresh less often as more are pinned, to stay inside its limit of 1,000 requests an hour.';
    const status = document.createElement('div');
    status.className = 'ship-ov-status';
    status.append(this.updated, this.slowed);
    this.refreshButton = document.createElement('button');
    this.refreshButton.type = 'button';
    this.refreshButton.className = 'ship-chip';
    this.refreshButton.textContent = 'Refresh';
    this.refreshButton.addEventListener('click', () => void this.refresh());
    const accountsButton = document.createElement('button');
    accountsButton.type = 'button';
    accountsButton.className = 'ship-chip';
    accountsButton.textContent = 'Accounts';
    accountsButton.title = 'Manage code host accounts';
    accountsButton.addEventListener('click', () => this.handlers.onOpenAccounts(null));
    this.addButton = document.createElement('button');
    this.addButton.type = 'button';
    this.addButton.className = 'ship-chip';
    this.addButton.textContent = 'Add';
    this.addButton.title = 'Pin a repo to the Overview';
    this.addButton.addEventListener('click', () => this.setAddOpen(!this.addOpen));
    bar.append(status, this.addButton, accountsButton, this.refreshButton);

    this.list = document.createElement('div');
    this.list.className = 'ship-ov-list';
    this.empty = document.createElement('div');
    this.empty.className = 'ship-note';
    this.empty.textContent = 'No repos on the Overview yet. Pin a repo from its Ship view, or add one here.';

    this.addRepo.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || shipOverviewStore.rows().length === 0) return;
      e.preventDefault();
      this.setAddOpen(false);
      this.addButton.focus();
    });

    // With no pins the list is empty, so the box sits under the note; with pins it opens under the bar.
    this.el.append(bar, this.empty, this.addRepo.el, this.list);
    this.unsubscribe = shipOverviewStore.subscribe(() => this.render());
    this.render();
  }

  /** Polling runs while the view is on screen; the age text ticks only then too. */
  setWanted(on: boolean): void {
    const want = on && !this.disposed;
    shipOverviewStore.setWanted(this.key, want);
    if (want) {
      this.addRepo.load();
      this.render();
      this.tick ??= setInterval(() => this.render(), TICK_MS);
    } else if (this.tick !== null) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }

  dispose(): void {
    this.setWanted(false);
    this.disposed = true;
    this.unsubscribe();
    this.addRepo.dispose();
  }

  private setAddOpen(open: boolean): void {
    this.addOpen = open;
    this.render();
    if (open) this.addRepo.focus();
  }

  private async refresh(): Promise<void> {
    this.refreshButton.disabled = true;
    try {
      await shipOverviewStore.refresh();
    } finally {
      if (!this.disposed) this.refreshButton.disabled = false;
    }
  }

  private render(): void {
    const now = Date.now();
    const entries = shipOverviewStore.rows();
    setText(this.updated, updatedText(shipOverviewStore.lastUpdated(), now));
    const slowedMs = shipOverviewStore.bitbucketSlowedMs();
    this.slowed.hidden = slowedMs === null;
    setText(this.slowed, slowedMs === null ? '' : bitbucketSlowedText(slowedMs));
    this.empty.hidden = entries.length > 0;
    this.refreshButton.hidden = entries.length === 0;
    // The first pin made from the inline box leaves it open, so several suggestions can be pinned in a row.
    if (entries.length === 0) this.addOpen = true;
    this.addButton.hidden = entries.length === 0;
    this.addButton.setAttribute('aria-pressed', String(this.addOpen));
    this.addRepo.el.hidden = !this.addOpen;

    const seen = new Set<string>();
    const ordered: HTMLElement[] = [];
    for (const entry of entries) {
      seen.add(entry.pin.repo);
      let row = this.rows.get(entry.pin.repo);
      if (row) row.update(entry, now);
      else {
        row = new ShipOverviewRow(entry, this.handlers);
        this.rows.set(entry.pin.repo, row);
      }
      ordered.push(row.el);
    }
    for (const [repo, row] of this.rows) {
      if (seen.has(repo)) continue;
      row.el.remove();
      this.rows.delete(repo);
    }
    // Re-appending moves a focused row and drops its focus, so only reorder when the order changed.
    if (!sameOrder(this.list.children, ordered)) this.list.replaceChildren(...ordered);
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function sameOrder(current: HTMLCollection, wanted: readonly HTMLElement[]): boolean {
  return current.length === wanted.length && wanted.every((el, i) => current[i] === el);
}
