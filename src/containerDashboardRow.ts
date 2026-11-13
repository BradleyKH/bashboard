import { attachContextMenu } from './contextMenu';
import { containerSectionMenuItems } from './containerMenus';
import {
  engineLabel,
  type DashboardContainerRow,
  type DashboardGroupRow,
  type DashboardUnavailableRow,
} from './containerGroups';
import type { ContainersSectionCallbacks } from './containersSection';
import { iconButton } from './rowControls';

/** One row in the dashboard's Containers section (docs/design/containers.md section 4.16). */
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
    text.textContent = `${engineLabel(row.engine)} ${unavailableText(row)}`;
    el.append(text);
    if (row.canStart && row.pending === null) {
      const start = iconButton('Start', 'container-engine-start', `Start ${engineLabel(row.engine)}`, () =>
        callbacks.onStartEngine(row.engine),
      );
      el.append(start);
    }
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
  el.append(actionSlot(row, callbacks));
  return el;
}

function unavailableText(row: DashboardUnavailableRow): string {
  if (row.pending === 'starting') return 'is starting\u2026';
  if (row.pending === 'stopping') return 'is stopping\u2026';
  return 'is not running';
}

/**
 * One slot per row so the counts line up. A multi-container group can be partly running, where a
 * single Start or Stop would hide which containers it acts on, so its slot stays empty: clicking
 * the row opens it in the Containers tab, and its context menu still offers Start and Stop.
 */
function actionSlot(row: DashboardGroupRow, callbacks: ContainersSectionCallbacks): HTMLElement {
  if (row.total > 1) {
    const spacer = document.createElement('span');
    spacer.className = 'container-action-spacer';
    return spacer;
  }
  return row.anyRunning
    ? iconButton('■', 'container-action', 'Stop', () => callbacks.onStop(row))
    : iconButton('▶', 'container-action', 'Start', () => callbacks.onStart(row));
}
