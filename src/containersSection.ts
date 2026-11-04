import './containersSection.css';
import { renderContainerDashboardRow } from './containerDashboardRow';
import { dashboardRows, type DashboardGroupRow } from './containerGroups';
import type { ContainersSnapshot, Engine } from './containers';

export interface ContainersSectionCallbacks {
  /** Open the Containers tab, expanding the groups with these keys. */
  onOpenContainers(groupKeys?: string[]): void;
  /** Start every stopped container in the row's member groups, on each engine. */
  onStart(row: DashboardGroupRow): void;
  /** Stop every running container in the row's member groups, on each engine. */
  onStop(row: DashboardGroupRow): void;
  /** Start an engine that is not running. The dashboard never stops one. */
  onStartEngine(engine: Engine): void;
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
    open.append(openIcon());
    open.title = 'Open the Containers tab';
    open.setAttribute('aria-label', 'Manage containers');
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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An arrow leaving a square: the Manage button opens the Containers tab. */
function openIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M13.5 9v3.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5h3.5', 'M13.5 2.5 8 8', 'M10 2.5h3.5V6']) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
