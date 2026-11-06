import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import type { Listener } from './ports';
import { isExposed, listenerTooltip, processLabel } from './portsModel';

export interface PortRowOptions {
  /** The owning pane's title, or null when no pane started it. */
  owner: string | null;
  /** Flashes the row once, for a port that just opened. */
  fresh: boolean;
  nowSec: number;
  onClick: () => void;
  menuItems: () => MenuEntry[];
}

/** One row in the dashboard's Ports section (docs/design/containers.md section 4.19). */
export function renderPortRow(l: Listener, opts: PortRowOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = 'favorite-row port-row';
  el.classList.toggle('fresh', opts.fresh);
  el.title = listenerTooltip(l, opts.owner, opts.nowSec);

  const dot = document.createElement('span');
  dot.className = 'status-dot port-dot';
  dot.classList.toggle('exposed', isExposed(l.addresses));

  const port = document.createElement('span');
  port.className = 'port-number';
  port.textContent = String(l.port);

  const name = document.createElement('span');
  name.className = 'port-name';
  name.textContent = processLabel(l.name);

  el.append(dot, port, name);
  if (opts.owner) {
    const owner = document.createElement('span');
    owner.className = 'port-owner';
    owner.textContent = opts.owner;
    el.append(owner);
  }
  el.addEventListener('click', opts.onClick);
  attachContextMenu(el, () => ({ entries: opts.menuItems(), target: el }));
  return el;
}
