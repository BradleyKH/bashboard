import { ForgeAddRepo } from './forgeAddRepo';
import { ForgeOverviewRow, type OverviewRowHandlers } from './forgeOverviewRow';
import { forgeOverviewStore } from './forgeOverviewStore';
import { bitbucketSlowedText, updatedText } from './forgeOverviewText';

/** The ages and the Updated line tick at this pace while the view is wanted. */
const TICK_MS = 30_000;

let nextId = 1;

/** The Forge pane's Overview view: one row per pinned repo in attention order (docs/design.md section 4.20). */
export class ForgeOverview {
  readonly el: HTMLElement;
  private readonly key = `overview:${nextId++}`;
  private readonly rows = new Map<string, ForgeOverviewRow>();
  private readonly updated: HTMLElement;
  private readonly slowed: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly addRepo = new ForgeAddRepo();
  private readonly unsubscribe: () => void;
  private tick: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly handlers: OverviewRowHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'forge-overview';

    const bar = document.createElement('div');
    bar.className = 'forge-ov-bar';
    this.updated = document.createElement('span');
    this.updated.className = 'forge-ov-updated';
    this.slowed = document.createElement('span');
    this.slowed.className = 'forge-ov-slowed';
    this.slowed.title = 'Bitbucket repos refresh less often as more are pinned, to stay inside its limit of 1,000 requests an hour.';
    const status = document.createElement('div');
    status.className = 'forge-ov-status';
    status.append(this.updated, this.slowed);
    this.refreshButton = document.createElement('button');
    this.refreshButton.type = 'button';
    this.refreshButton.className = 'forge-chip';
    this.refreshButton.textContent = 'Refresh';
    this.refreshButton.addEventListener('click', () => void this.refresh());
    bar.append(status, this.refreshButton);

    this.list = document.createElement('div');
    this.list.className = 'forge-ov-list';
    this.empty = document.createElement('div');
    this.empty.className = 'forge-note';
    this.empty.textContent = 'No repos on the Overview yet. Pin a repo from its Forge view, or add one here.';

    this.el.append(bar, this.list, this.empty, this.addRepo.el);
    this.unsubscribe = forgeOverviewStore.subscribe(() => this.render());
    this.render();
  }

  /** Polling runs while the view is on screen; the age text ticks only then too. */
  setWanted(on: boolean): void {
    const want = on && !this.disposed;
    forgeOverviewStore.setWanted(this.key, want);
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

  private async refresh(): Promise<void> {
    this.refreshButton.disabled = true;
    try {
      await forgeOverviewStore.refresh();
    } finally {
      if (!this.disposed) this.refreshButton.disabled = false;
    }
  }

  private render(): void {
    const now = Date.now();
    const entries = forgeOverviewStore.rows();
    setText(this.updated, updatedText(forgeOverviewStore.lastUpdated(), now));
    const slowedMs = forgeOverviewStore.bitbucketSlowedMs();
    this.slowed.hidden = slowedMs === null;
    setText(this.slowed, slowedMs === null ? '' : bitbucketSlowedText(slowedMs));
    this.empty.hidden = entries.length > 0;
    this.refreshButton.hidden = entries.length === 0;

    const seen = new Set<string>();
    const ordered: HTMLElement[] = [];
    for (const entry of entries) {
      seen.add(entry.pin.repo);
      let row = this.rows.get(entry.pin.repo);
      if (row) row.update(entry, now);
      else {
        row = new ForgeOverviewRow(entry, this.handlers);
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
