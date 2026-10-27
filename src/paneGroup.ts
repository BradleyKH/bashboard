import type { PaneGroup } from './dashboardModel';

/**
 * One tab's group in the dashboard's Panes section (docs/design.md section 4.6): a header and,
 * under it, the tab's cards along a guide line.
 */
export function renderPaneGroup(
  group: PaneGroup,
  cards: HTMLElement[],
  onSwitchTab: (tabId: string) => void,
): HTMLElement {
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
  header.addEventListener('click', () => onSwitchTab(group.tabId));

  const list = document.createElement('div');
  list.className = 'terminal-group-cards';
  list.append(...cards);

  el.append(header, list);
  return el;
}
