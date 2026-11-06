import './portsSection.css';
import { openTabButton } from './openTabIcon';
import { portMenuItems } from './portMenus';
import { renderPortRow } from './portRow';
import type { Listener } from './ports';
import { dashboardListeners, listenerKey, newKeys } from './portsModel';

export interface PortsSectionCallbacks {
  /** Open the Ports tab, highlighting the row with this `listenerKey`, or listing every port with `showAll`. */
  onOpenPorts(key?: string, showAll?: boolean): void;
  /** The title of the pane running pty `ptyId`, or null when it has closed. */
  ownerTitle(ptyId: number): string | null;
  /** Focus the pane running pty `ptyId`. */
  onGoToPane(ptyId: number): void;
  onOpenUrl(url: string): void;
  onCopy(text: string, what: string): void;
  /** Ask, then stop the listener's process. */
  onStop(l: Listener): void;
}

/** The dashboard's Ports section: what is listening, and which pane started it (docs/design/containers.md section 4.19). */
export class PortsSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;
  /** Keys in the last render, so a port that appears after it can flash once. */
  private seen: Set<string> | null = null;

  constructor(private readonly callbacks: PortsSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section ports-section';

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Ports';
    this.head.append(h, openTabButton('Open the Ports tab', 'Manage ports', () => this.callbacks.onOpenPorts()));

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
    this.update([], false);
  }

  /** `ready` is false until the first poll answers, which shows a placeholder rather than "none". */
  update(all: readonly Listener[], ready: boolean): void {
    const { rows, others } = dashboardListeners(all);
    const fresh = ready ? newKeys(this.seen, rows) : new Set<string>();
    if (ready) this.seen = new Set(rows.map(listenerKey));
    const cb = this.callbacks;
    const more: HTMLElement[] = [];
    if (others > 0) {
      const row = document.createElement('div');
      row.className = 'favorite-row port-row port-others';
      row.textContent = `+ ${others} other ${others === 1 ? 'program' : 'programs'}`;
      row.title = 'Open the Ports tab to see them';
      row.addEventListener('click', () => cb.onOpenPorts(undefined, true));
      more.push(row);
    }
    if (rows.length === 0 && more.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = ready ? 'Nothing listening' : '-';
      this.list.replaceChildren(empty);
      return;
    }
    const nowSec = Date.now() / 1000;
    this.list.replaceChildren(
      ...rows.map((l) => {
        const owner = l.ptyId === null ? null : cb.ownerTitle(l.ptyId);
        const ptyId = owner === null ? null : l.ptyId;
        const goToPane = ptyId === null ? undefined : () => cb.onGoToPane(ptyId);
        return renderPortRow(l, {
          owner,
          fresh: fresh.has(listenerKey(l)),
          nowSec,
          onClick: goToPane ?? (() => cb.onOpenPorts(listenerKey(l))),
          menuItems: () =>
            portMenuItems(l, {
              onOpenUrl: cb.onOpenUrl,
              onCopy: cb.onCopy,
              onGoToPane: goToPane,
              onOpenPorts: () => cb.onOpenPorts(listenerKey(l)),
              onStop: () => cb.onStop(l),
            }),
        });
      }),
      ...more,
    );
  }
}
