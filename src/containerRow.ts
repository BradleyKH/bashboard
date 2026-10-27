import { invoke } from '@tauri-apps/api/core';
import type { Container, ContainerAction, ContainerPort, ContainerStats } from './containers';

export interface ContainerRowOptions {
  /** The latest stats sample; null while none has arrived or the container is not running. */
  stats: ContainerStats | null;
  /** This container's logs are open in the panel. */
  logsOpen: boolean;
  /** An action on it is in flight; its buttons are disabled meanwhile. */
  busy: boolean;
  onAction: (action: ContainerAction) => void;
  onLogs: () => void;
  onShell: () => void;
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

function portLink(p: ContainerPort): HTMLElement {
  const text = `${p.host}:${p.container}${p.protocol === 'tcp' ? '' : `/${p.protocol}`}`;
  // Only TCP ports can serve http; a UDP mapping is shown but not linked.
  if (p.protocol !== 'tcp') {
    const span = document.createElement('span');
    span.className = 'ctr-port';
    span.textContent = text;
    return span;
  }
  const url = `http://localhost:${p.host}`;
  const a = document.createElement('a');
  a.className = 'ctr-port ctr-port-link';
  a.href = url;
  a.textContent = text;
  a.title = `Open ${url}`;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    invoke('open_url', { url }).catch((err: unknown) => console.warn('open_url failed', err));
  });
  return a;
}

/** The usage line for a sample, or '' when it has nothing to show. */
export function containerUsage(stats: ContainerStats): string {
  const parts: string[] = [];
  if (stats.cpuPercent !== null) parts.push(`CPU ${stats.cpuPercent.toFixed(1)}%`);
  if (stats.memUsage) parts.push(`Mem ${stats.memUsage.split('/')[0].trim()}`);
  else if (stats.memPercent !== null) parts.push(`Mem ${stats.memPercent.toFixed(1)}%`);
  return parts.join('  ');
}

/** One container in the Containers pane (docs/design.md section 4.16). */
export function renderContainerRow(c: Container, opts: ContainerRowOptions): HTMLElement {
  const running = c.state === 'running';
  const el = document.createElement('div');
  el.className = 'ctr-row';
  if (opts.logsOpen) el.classList.add('logs-open');

  const dot = document.createElement('span');
  dot.className = `ctr-dot state-${c.state}`;
  dot.title = c.state;

  const main = document.createElement('div');
  main.className = 'ctr-row-main';
  const line = document.createElement('div');
  line.className = 'ctr-row-line';
  const name = document.createElement('span');
  name.className = 'ctr-name';
  name.textContent = c.service ?? c.name;
  name.title = c.name;
  const image = document.createElement('span');
  image.className = 'ctr-meta';
  image.textContent = c.image;
  image.title = c.image;
  line.append(name, image);

  const detail = document.createElement('div');
  detail.className = 'ctr-row-line ctr-detail';
  const status = document.createElement('span');
  status.className = 'ctr-meta ctr-status';
  status.textContent = c.statusText;
  detail.append(status);
  for (const p of c.ports) detail.append(portLink(p));
  if (running && opts.stats) {
    const u = containerUsage(opts.stats);
    if (u) {
      const stats = document.createElement('span');
      stats.className = 'ctr-meta ctr-stats';
      stats.textContent = u;
      if (opts.stats.memUsage) stats.title = `Memory ${opts.stats.memUsage}`;
      detail.append(stats);
    }
  }
  main.append(line, detail);

  const actions = document.createElement('div');
  actions.className = 'ctr-actions';
  actions.append(
    button('Start', `Start ${c.name}`, opts.busy || running, () => opts.onAction('start')),
    button('Stop', `Stop ${c.name}`, opts.busy || !running, () => opts.onAction('stop')),
    button('Restart', `Restart ${c.name}`, opts.busy, () => opts.onAction('restart')),
    button('Logs', `Follow the logs of ${c.name}`, false, opts.onLogs),
    button('Shell', `Open a shell in ${c.name}`, !running, opts.onShell),
  );

  el.append(dot, main, actions);
  return el;
}

/**
 * Rewrites the text a stats tick or status refresh changes, leaving every element in place.
 * Only valid while the row's structure is unchanged (see `renderKey`).
 */
export function updateContainerRow(el: HTMLElement, c: Container, stats: ContainerStats | null): void {
  const status = el.querySelector('.ctr-status');
  if (status && status.textContent !== c.statusText) status.textContent = c.statusText;
  const usageEl = el.querySelector<HTMLElement>('.ctr-stats');
  if (!usageEl || !stats) return;
  const u = containerUsage(stats);
  if (usageEl.textContent !== u) usageEl.textContent = u;
  usageEl.title = stats.memUsage ? `Memory ${stats.memUsage}` : '';
}
