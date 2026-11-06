// shipPane.css carries the status icon classes; the dashboard can render before any Ship pane exists.
import './shipPane.css';
import './shipSection.css';
import { statusInfo, type ShipTab } from './shipModel';
import type { RunStatus } from './forgeApi';
import type { DashboardItem } from './shipOverviewModel';
import { shipOverviewStore } from './shipOverviewStore';
import {
  itemStatus,
  itemText,
  itemTitle,
  pullsLine,
  repoLabel,
  runningLine,
  sectionItems,
  signInLine,
  type SummaryLine,
} from './shipSectionModel';
import { openTabButton } from './openTabIcon';

export interface ShipSectionCallbacks {
  /** Open the Ship Overview, drilled into `target` on `tab` when given; null opens the Overview itself. */
  onOpenShip(target: string | null, tab?: ShipTab): void;
  /** Open the Accounts tab on `host`; null leaves the choice of host to the tab. */
  onOpenAccounts(host: string | null, opts?: { openTokenForm?: boolean }): void;
}

/** The dashboard's Ship section: what needs the viewer, then what is moving, across the pinned repos (docs/design.md section 4.6). */
export class ShipSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly callbacks: ShipSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section ship-section';

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Ship';
    this.head.append(h, openTabButton('Open the Ship tab', 'Overview', () => this.callbacks.onOpenShip(null)));

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
    this.update();
  }

  /** Reads the store. Never empty: with nothing pinned it is a new user's way into Ship. */
  update(): void {
    const entries = shipOverviewStore.rows();
    if (entries.length === 0) {
      this.list.replaceChildren(
        this.renderRow('other', null, 'Pin repos', 'Open the Ship Overview to pin repos', () => this.callbacks.onOpenShip(null)),
      );
      return;
    }
    // A signed-out pin polls to an error, which only the Overview row would otherwise show.
    const signIn = signInLine(entries);
    const signInRows = signIn
      ? [
          this.renderRow('failure', null, signIn.text, signIn.title, () =>
            this.callbacks.onOpenAccounts(signIn.host, { openTokenForm: signIn.openTokenForm }),
          ),
        ]
      : [];
    // Entries come in attention order, so the summary lines follow the same order as the item rows.
    const rows = entries.flatMap((e) => (e.row ? [e.row] : []));
    if (rows.length === 0) {
      if (signIn) {
        this.list.replaceChildren(...signInRows);
        return;
      }
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = '-';
      this.list.replaceChildren(empty);
      return;
    }
    const { shown, reviewCount } = sectionItems(shipOverviewStore.items());
    const pulls = pullsLine(rows, reviewCount);
    this.list.replaceChildren(
      ...signInRows,
      ...shown.map((item) => this.renderItem(item)),
      this.renderLine(runningLine(rows, Date.now())),
      ...(pulls ? [this.renderLine(pulls)] : []),
    );
  }

  private renderItem(item: DashboardItem): HTMLElement {
    return this.renderRow(itemStatus(item), repoLabel(item.repo), itemText(item), itemTitle(item), () =>
      this.callbacks.onOpenShip(item.target, item.tab),
    );
  }

  private renderLine(line: SummaryLine): HTMLElement {
    return this.renderRow(line.status, line.repo, line.text, line.title, () =>
      this.callbacks.onOpenShip(line.target, line.tab),
    );
  }

  private renderRow(status: RunStatus, repo: string | null, text: string, title: string, onClick: () => void): HTMLElement {
    const el = document.createElement('div');
    el.className = 'favorite-row ship-item-row';
    el.title = title;

    const icon = document.createElement('span');
    icon.className = `ship-status ship-status--${statusInfo(status).modifier}`;
    el.append(icon);

    if (repo !== null) {
      const repoEl = document.createElement('span');
      repoEl.className = 'ship-item-repo';
      repoEl.textContent = repo;
      el.append(repoEl);
    }

    const textEl = document.createElement('span');
    textEl.className = 'ship-item-text';
    textEl.textContent = text;
    el.append(textEl);

    el.addEventListener('click', onClick);
    return el;
  }
}
