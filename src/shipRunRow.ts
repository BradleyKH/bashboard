import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import type { Capabilities, Run } from './forgeApi';
import { runActionStates, type RunActionKey } from './shipMenus';
import { duration, relativeTime, statusInfo } from './shipModel';

export interface RunRowHandlers {
  /** Expands or collapses the jobs under the row. */
  onToggle: (run: Run) => void;
  menuItems: (run: Run) => MenuEntry[];
  /** The host's capabilities, or null before the repo resolves; read on every update. */
  caps: () => Capabilities | null;
  onOpen: (run: Run) => void;
  onAction: (run: Run, action: RunActionKey) => void;
  onCopyLink: (run: Run) => void;
}

const ACTION_LABELS: Record<RunActionKey, [label: string, title: string]> = {
  rerun: ['Re-run', 'Run every job again'],
  rerunFailed: ['Re-run failed', 'Run only the failed jobs again'],
  cancel: ['Cancel', 'Stop this run'],
};

/** Sets text only when it changed, so a poll that changed nothing touches no DOM. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * One run in the Pipelines list (docs/design/ship.md section 4.20): the row itself and, under it, a
 * slot for its jobs. `update` changes the parts that differ, so an expanded run keeps its scroll
 * and focus.
 */
export class ShipRunRow {
  /** The run's block: the row, then the jobs slot. */
  readonly el: HTMLElement;
  /** Where the jobs view goes; empty and hidden while collapsed. */
  readonly detail: HTMLElement;
  private current: Run;
  private expanded = false;
  private readonly caps: () => Capabilities | null;

  private readonly row: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly side: HTMLElement;
  private readonly when: HTMLElement;
  private readonly took: HTMLElement;
  private readonly actionButtons: Record<RunActionKey, HTMLButtonElement>;

  constructor(run: Run, handlers: RunRowHandlers) {
    this.current = run;
    this.el = document.createElement('div');
    this.el.className = 'ship-run';

    this.row = document.createElement('div');
    this.row.className = 'ship-run-row';
    this.row.tabIndex = 0;
    this.row.setAttribute('role', 'button');

    this.icon = document.createElement('span');
    this.icon.className = 'ship-status';
    this.icon.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'ship-run-main';
    this.title = document.createElement('div');
    this.title.className = 'ship-run-title';
    this.meta = document.createElement('div');
    this.meta.className = 'ship-run-meta';
    main.append(this.title, this.meta);

    this.side = document.createElement('div');
    this.side.className = 'ship-run-side';
    this.when = document.createElement('span');
    this.when.className = 'ship-run-when';
    this.took = document.createElement('span');
    this.took.className = 'ship-run-took';
    this.side.append(this.when, this.took);

    // Every row carries the same buttons, disabled where the run's status rules one out, so they
    // line up down the list; what the host cannot do at all is hidden on every row alike.
    const actions = document.createElement('div');
    actions.className = 'ship-run-actions';
    const makeButton = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ship-run-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    const open = makeButton('Open', 'Open in browser', () => handlers.onOpen(this.current));
    const keys: RunActionKey[] = ['rerun', 'rerunFailed', 'cancel'];
    this.actionButtons = Object.fromEntries(
      keys.map((key) => {
        const [label, title] = ACTION_LABELS[key];
        return [key, makeButton(label, title, () => handlers.onAction(this.current, key))];
      }),
    ) as Record<RunActionKey, HTMLButtonElement>;
    const copy = makeButton('Copy link', 'Copy the link to this run', () => handlers.onCopyLink(this.current));
    actions.append(open, ...keys.map((k) => this.actionButtons[k]), copy);
    this.caps = handlers.caps;

    this.row.append(this.icon, main, this.side, actions);

    this.detail = document.createElement('div');
    this.detail.className = 'ship-run-detail';
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
    const iconClass = `ship-status ship-status--${info.modifier}`;
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

    const when = relativeTime(run.createdAt, nowMs);
    const took = duration(run, nowMs);
    setText(this.when, when);
    setText(this.took, took);
    const queued = Date.parse(run.createdAt);
    const sideLines: string[] = [];
    if (when) sideLines.push(`Queued: ${when}${Number.isNaN(queued) ? '' : ` (${new Date(queued).toLocaleString()})`}`);
    if (took) sideLines.push(`Duration: ${took}`);
    const sideTitle = sideLines.join('\n');
    if (this.side.title !== sideTitle) this.side.title = sideTitle;

    const caps = this.caps();
    const states = caps ? runActionStates(run, caps) : null;
    for (const [key, button] of Object.entries(this.actionButtons) as [RunActionKey, HTMLButtonElement][]) {
      const state = states?.[key];
      const hidden = !state?.offered;
      const disabled = !state?.enabled;
      if (button.hidden !== hidden) button.hidden = hidden;
      if (button.disabled !== disabled) button.disabled = disabled;
    }
  }
}
