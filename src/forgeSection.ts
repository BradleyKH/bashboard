// forgePane.css carries the status icon classes; the dashboard can render before any Forge pane exists.
import './forgePane.css';
import './forgeSection.css';
import { statusInfo, type ForgeTab } from './forgeModel';
import type { DashboardItem } from './forgeOverviewModel';
import { forgeOverviewStore } from './forgeOverviewStore';
import { isAllClear, itemStatus, itemText, itemTitle, repoLabel } from './forgeSectionModel';
import { openTabButton } from './openTabIcon';

export interface ForgeSectionCallbacks {
  /** Open the Forge Overview, drilled into `target` on `tab` when given; null opens the Overview itself. */
  onOpenForge(target: string | null, tab?: ForgeTab): void;
}

/** The dashboard's Forge section: only what needs the viewer across the pinned repos (docs/design.md section 4.20). */
export class ForgeSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly callbacks: ForgeSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section forge-section';

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Forge';
    this.head.append(h, openTabButton('Open the Forge tab', 'Overview', () => this.callbacks.onOpenForge(null)));

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
    this.update();
  }

  /** Reads the store; the section is hidden while nothing is pinned. */
  update(): void {
    const entries = forgeOverviewStore.rows();
    this.el.hidden = entries.length === 0;
    if (entries.length === 0) return;
    const items = forgeOverviewStore.items();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = isAllClear(entries, items) ? 'All clear' : '-';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...items.map((item) => this.renderItem(item)));
  }

  private renderItem(item: DashboardItem): HTMLElement {
    const el = document.createElement('div');
    el.className = 'favorite-row forge-item-row';
    el.title = itemTitle(item);

    const icon = document.createElement('span');
    icon.className = `forge-status forge-status--${statusInfo(itemStatus(item)).modifier}`;

    const repo = document.createElement('span');
    repo.className = 'forge-item-repo';
    repo.textContent = repoLabel(item.repo);

    const text = document.createElement('span');
    text.className = 'forge-item-text';
    text.textContent = itemText(item);

    el.append(icon, repo, text);
    el.addEventListener('click', () => this.callbacks.onOpenForge(item.target, item.tab));
    return el;
  }
}
