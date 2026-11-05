import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import type { Run } from './forgeApi';
import { duration, relativeTime, statusInfo } from './forgeModel';

export interface RunRowHandlers {
  /** Expands or collapses the jobs under the row. */
  onToggle: (run: Run) => void;
  menuItems: (run: Run) => MenuEntry[];
}

/** Sets text only when it changed, so a poll that changed nothing touches no DOM. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * One run in the Pipelines list (docs/design.md section 4.20): the row itself and, under it, a slot
 * for its jobs. `update` changes the parts that differ, so an expanded run keeps its scroll and focus.
 */
export class ForgeRunRow {
  /** The run's block: the row, then the jobs slot. */
  readonly el: HTMLElement;
  /** Where the jobs view goes; empty and hidden while collapsed. */
  readonly detail: HTMLElement;
  private current: Run;
  private expanded = false;

  private readonly row: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly when: HTMLElement;
  private readonly took: HTMLElement;

  constructor(run: Run, handlers: RunRowHandlers) {
    this.current = run;
    this.el = document.createElement('div');
    this.el.className = 'forge-run';

    this.row = document.createElement('div');
    this.row.className = 'forge-run-row';
    this.row.tabIndex = 0;
    this.row.setAttribute('role', 'button');

    this.icon = document.createElement('span');
    this.icon.className = 'forge-status';
    this.icon.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'forge-run-main';
    this.title = document.createElement('div');
    this.title.className = 'forge-run-title';
    this.meta = document.createElement('div');
    this.meta.className = 'forge-run-meta';
    main.append(this.title, this.meta);

    const side = document.createElement('div');
    side.className = 'forge-run-side';
    this.when = document.createElement('span');
    this.when.className = 'forge-run-when';
    this.took = document.createElement('span');
    this.took.className = 'forge-run-took';
    side.append(this.when, this.took);

    this.row.append(this.icon, main, side);

    this.detail = document.createElement('div');
    this.detail.className = 'forge-run-detail';
    this.detail.hidden = true;
    this.el.append(this.row, this.detail);

    this.row.addEventListener('click', () => handlers.onToggle(this.current));
    this.row.addEventListener('keydown', (e) => {
      if (e.target !== this.row || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      handlers.onToggle(this.current);
    });
    attachContextMenu(this.row, () => ({ entries: handlers.menuItems(this.current), target: this.row }));

    this.update(run, Date.now());
  }

  get run(): Run {
    return this.current;
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(on: boolean): void {
    this.expanded = on;
    this.detail.hidden = !on;
    this.el.classList.toggle('expanded', on);
    this.row.setAttribute('aria-expanded', String(on));
  }

  /** `nowMs` is epoch milliseconds, for the relative time and a running run's elapsed time. */
  update(run: Run, nowMs: number): void {
    this.current = run;
    const info = statusInfo(run.status);
    const iconClass = `forge-status forge-status--${info.modifier}`;
    if (this.icon.className !== iconClass) this.icon.className = iconClass;
    if (this.icon.title !== info.label) this.icon.title = info.label;

    setText(this.title, run.title || run.name);
    if (this.title.title !== run.title) this.title.title = run.title;

    const parts: string[] = [];
    if (run.name && run.name !== run.title) parts.push(run.name);
    if (run.number !== null) parts.push(`#${run.number}`);
    if (run.branch) parts.push(run.branch);
    if (run.actor) parts.push(run.actor);
    setText(this.meta, parts.join('  ·  '));

    setText(this.when, relativeTime(run.createdAt, nowMs));
    setText(this.took, duration(run, nowMs));
  }
}
