import type { ContainerAction } from './containers';
import type { ContainerGroup } from './containerGroups';

export interface ContainerGroupViewOptions {
  expanded: boolean;
  /** An action on the whole group is in flight; its buttons are disabled meanwhile. */
  busy: boolean;
  onToggle: () => void;
  /** Start, Stop, or Restart every container in the group. */
  onAction: (action: ContainerAction) => void;
  /** Renders one member row; called only while expanded. */
  renderRow: (index: number) => HTMLElement;
}

function button(label: string, title: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctr-btn';
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** A group header plus, when expanded, its containers (docs/design.md section 4.16). */
export function renderContainerGroup(g: ContainerGroup, opts: ContainerGroupViewOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ctr-group';
  if (opts.expanded) el.classList.add('expanded');

  const head = document.createElement('div');
  head.className = 'ctr-group-head';
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', String(opts.expanded));
  head.addEventListener('click', () => opts.onToggle());

  const toggle = document.createElement('span');
  toggle.className = 'ctr-toggle';
  toggle.textContent = opts.expanded ? '▾' : '▸';

  const dot = document.createElement('span');
  dot.className = `ctr-dot group-${g.state}`;
  dot.title = g.state;

  const name = document.createElement('span');
  name.className = 'ctr-name ctr-group-name';
  name.textContent = g.name;
  name.title = g.name;

  const running = g.containers.filter((c) => c.state === 'running').length;
  const count = document.createElement('span');
  count.className = 'ctr-meta';
  count.textContent = `${running} of ${g.containers.length}`;

  const actions = document.createElement('div');
  actions.className = 'ctr-actions';
  actions.append(
    button('Start', `Start ${g.name}`, opts.busy || g.state === 'running', () => opts.onAction('start')),
    button('Stop', `Stop ${g.name}`, opts.busy || g.state === 'stopped', () => opts.onAction('stop')),
    button('Restart', `Restart ${g.name}`, opts.busy, () => opts.onAction('restart')),
  );

  head.append(toggle, dot, name, count, actions);
  el.append(head);

  if (opts.expanded) {
    const rows = document.createElement('div');
    rows.className = 'ctr-rows';
    for (let i = 0; i < g.containers.length; i++) rows.append(opts.renderRow(i));
    el.append(rows);
  }
  return el;
}
