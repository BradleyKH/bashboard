import { attachContextMenu } from './contextMenu';
import { item } from './contextMenuModel';
import type { PaneGroup } from './dashboardModel';
import { setRowRename, startRename } from './rowControls';

export interface PaneGroupHandlers {
  onSwitchTab: (tabId: string) => void;
  /** An empty name returns the tab to following its focused pane's title. */
  onRename: (tabId: string, name: string) => void;
}

/**
 * One tab's group in the dashboard's Panes section (docs/design/dashboard.md section 4.6): a header
 * and, under it, the tab's cards along a guide line.
 */
export function renderPaneGroup(group: PaneGroup, cards: HTMLElement[], handlers: PaneGroupHandlers): HTMLElement {
  const el = document.createElement('div');
  el.className = 'terminal-group';
  el.classList.toggle('active', group.active);
  el.dataset.tabId = group.tabId;

  const header = document.createElement('div');
  header.className = 'terminal-group-header';
  header.classList.toggle('attention', group.attention);
  header.dataset.tabId = group.tabId;
  header.title = group.active ? 'Active tab' : 'Switch to this tab';

  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.title;

  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = String(group.count);

  header.append(name, count);
  header.addEventListener('click', () => handlers.onSwitchTab(group.tabId));

  const beginRename = (): void =>
    startRename(name, group.name ?? group.title, (value) => handlers.onRename(group.tabId, value), {
      allowEmpty: true,
    });
  setRowRename(header, beginRename);
  attachContextMenu(header, () => ({ entries: [item('Rename', beginRename)], target: header }));

  const list = document.createElement('div');
  list.className = 'terminal-group-cards';
  list.append(...cards);
  // The AI filter can leave a tab with no cards; an empty list would still take the group's gap.
  list.hidden = cards.length === 0;

  el.append(header, list);
  return el;
}
