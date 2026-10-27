import { engineLabel, type DashboardContainerRow } from './containerGroups';
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
  if (row.anyStopped) {
    el.append(iconButton('\u25B6', 'container-action', 'Start', () => callbacks.onStart(row)));
  }
  if (row.anyRunning) {
    el.append(iconButton('\u25A0', 'container-action', 'Stop', () => callbacks.onStop(row)));
  }
  return el;
}
