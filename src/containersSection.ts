import './containersSection.css';
import { renderContainerDashboardRow } from './containerDashboardRow';
import { dashboardRows, type DashboardGroupRow } from './containerGroups';
import type { ContainersSnapshot } from './containers';

export interface ContainersSectionCallbacks {
  /** Open the Containers tab, expanding the groups with these keys. */
  onOpenContainers(groupKeys?: string[]): void;
  /** Start every stopped container in the row's member groups, on each engine. */
  onStart(row: DashboardGroupRow): void;
  /** Stop every running container in the row's member groups, on each engine. */
  onStop(row: DashboardGroupRow): void;
}

/** The dashboard's Containers section: one row per container group (docs/design.md sections 4.6 and 4.16). */
export class ContainersSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly callbacks: ContainersSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section containers-section';

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Containers';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'containers-open';
    open.textContent = 'Open Containers';
    open.title = 'Open the Containers tab';
    open.addEventListener('click', () => this.callbacks.onOpenContainers());
    this.head.append(h, open);

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
  }

  update(snapshot: ContainersSnapshot): void {
    const rows = dashboardRows(snapshot);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = 'No containers';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...rows.map((r) => renderContainerDashboardRow(r, this.callbacks)));
  }

  /** The caller decides visibility: engine availability and the setting live outside the section. */
  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }
}
