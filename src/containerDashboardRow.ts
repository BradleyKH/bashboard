import { attachContextMenu } from './contextMenu';
import { containerSectionMenuItems } from './containerMenus';
import { engineLabel, type DashboardContainerRow, type DashboardGroupRow } from './containerGroups';
import type { ContainersSectionCallbacks } from './containersSection';
import { iconButton } from './rowControls';

/** One row in the dashboard's Containers section (docs/design.md section 4.16). */
export function renderContainerDashboardRow(
  row: DashboardContainerRow,
  callbacks: ContainersSectionCallbacks,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'favorite-row container-row';

  if (row.kind === 'unavailable') {
    el.classList.add('unavailable');
    const text = document.createElement('div');
    text.className = 'container-name';
    text.textContent = `${engineLabel(row.engine)} is not running`;
    el.append(text);
    return el;
  }

  const dot = document.createElement('span');
  dot.className = `status-dot container-dot ${row.state}`;

  const name = document.createElement('div');
  name.className = 'container-name';
  name.textContent = row.name;
  name.title = row.name;

  const count = document.createElement('span');
  count.className = 'container-count';
  count.textContent = `${row.running} of ${row.total}`;

  el.title = 'Open in Containers';
  el.addEventListener('click', () => callbacks.onOpenContainers(row.groupKeys));
  el.append(dot, name, count);
  attachContextMenu(el, () => ({
    entries: containerSectionMenuItems(row, {
      onStart: () => callbacks.onStart(row),
      onStop: () => callbacks.onStop(row),
      onOpenContainers: () => callbacks.onOpenContainers(row.groupKeys),
    }),
    target: el,
  }));
  el.append(actionButton(row, callbacks));
  return el;
}

/**
 * Exactly one button per row so the counts line up. A multi-container group can be partly
 * running, where a single Start or Stop would hide which containers it acts on, so it gets a
 * details button into the Containers tab instead; its context menu still offers Start and Stop.
 */
function actionButton(row: DashboardGroupRow, callbacks: ContainersSectionCallbacks): HTMLButtonElement {
  if (row.total > 1) {
    return iconButton('\u203A', 'container-action', 'Show containers', () =>
      callbacks.onOpenContainers(row.groupKeys),
    );
  }
  return row.anyRunning
    ? iconButton('\u25A0', 'container-action', 'Stop', () => callbacks.onStop(row))
    : iconButton('\u25B6', 'container-action', 'Start', () => callbacks.onStart(row));
}
