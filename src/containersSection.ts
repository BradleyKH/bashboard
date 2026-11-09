import './containersSection.css';
import { renderContainerDashboardRow } from './containerDashboardRow';
import { dashboardRows, visibleDashboardRows, type DashboardGroupRow } from './containerGroups';
import type { ContainersSnapshot, Engine } from './containers';
import { eyeIcon } from './eyeIcon';
import { openTabButton } from './openTabIcon';

export interface ContainersSectionCallbacks {
  /** Open the Containers tab, expanding the groups with these keys. */
  onOpenContainers(groupKeys?: string[]): void;
  /** Start every stopped container in the row's member groups, on each engine. */
  onStart(row: DashboardGroupRow): void;
  /** Stop every running container in the row's member groups, on each engine. */
  onStop(row: DashboardGroupRow): void;
  /** Start an engine that is not running. The dashboard never stops one. */
  onStartEngine(engine: Engine): void;
  /** The user toggled whether fully stopped groups are listed. */
  onShowStoppedChange?(shown: boolean): void;
}

/** The dashboard's Containers section: one row per container group (docs/design/dashboard.md sections 4.6 and 4.16). */
export class ContainersSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;
  private readonly stoppedButton: HTMLButtonElement;
  private showStopped = true;
  private snapshot: ContainersSnapshot | null = null;

  constructor(private readonly callbacks: ContainersSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section containers-section';

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Containers';
    this.stoppedButton = document.createElement('button');
    this.stoppedButton.type = 'button';
    this.stoppedButton.className = 'section-open containers-stopped';
    this.stoppedButton.setAttribute('aria-label', 'Stopped containers');
    this.stoppedButton.addEventListener('click', () => {
      this.setShowStopped(!this.showStopped);
      this.callbacks.onShowStoppedChange?.(this.showStopped);
    });
    this.syncStoppedButton();
    const open = openTabButton('Open the Containers tab', 'Manage containers', () => this.callbacks.onOpenContainers());
    this.head.append(h, this.stoppedButton, open);

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
  }

  update(snapshot: ContainersSnapshot): void {
    this.snapshot = snapshot;
    const all = dashboardRows(snapshot);
    const rows = visibleDashboardRows(all, this.showStopped);
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = all.length === 0 ? 'No containers' : 'No running containers';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...rows.map((r) => renderContainerDashboardRow(r, this.callbacks)));
  }

  /** Applies the saved toggle without firing `onShowStoppedChange`. */
  setShowStopped(shown: boolean): void {
    if (shown === this.showStopped) return;
    this.showStopped = shown;
    this.syncStoppedButton();
    if (this.snapshot) this.update(this.snapshot);
  }

  stoppedShown(): boolean {
    return this.showStopped;
  }

  /** The caller decides visibility: engine availability and the setting live outside the section. */
  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }

  private syncStoppedButton(): void {
    this.stoppedButton.setAttribute('aria-pressed', String(this.showStopped));
    this.stoppedButton.title = this.showStopped ? 'Hide stopped containers' : 'Show stopped containers';
    this.stoppedButton.replaceChildren(eyeIcon(!this.showStopped));
  }
}
