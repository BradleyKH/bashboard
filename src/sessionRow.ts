import { formatAge, lastFolder } from './dashboardModel';
import { folderButton } from './folderButton';
import { openMenuButton, type OpenInHandler } from './openMenu';
import { hueCss, sessionHue } from './sessionHue';
import type { Session, SessionStatus } from './sessions';
import { showToast } from './toast';

export interface SessionRowOptions {
  now: number;
  expanded: boolean;
  onToggle: (sessionId: string) => void;
  /** Open menu beside the folder button; omitted, the row shows none. */
  onOpenIn?: OpenInHandler;
}

const DOT_CLASS: Record<SessionStatus, string> = {
  busy: 'working',
  idle: 'idle',
  waiting: 'waiting',
  unknown: 'idle',
};

function detail(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'session-detail';

  const text = document.createElement('span');
  text.className = 'session-detail-value';
  text.textContent = value;
  text.title = `${label}: ${value}`;

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'session-copy';
  copy.textContent = 'Copy';
  copy.title = `Copy ${label}`;
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(
      () => showToast(`Copied ${label}`, 1500),
      (err) => showToast(`Could not copy: ${String(err)}`),
    );
  });

  row.append(text, copy);
  return row;
}

/** One row in the dashboard's External sessions section (docs/design.md section 4.6). */
export function renderSessionRow(session: Session, opts: SessionRowOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = 'session-row';
  el.classList.toggle('expanded', opts.expanded);
  el.dataset.sessionId = session.sessionId;

  const head = document.createElement('div');
  head.className = 'session-head';
  head.addEventListener('click', () => opts.onToggle(session.sessionId));

  const dot = document.createElement('span');
  dot.className = `status-dot ${DOT_CLASS[session.status]}`;
  dot.title = session.rawStatus ?? session.status;

  const swatch = document.createElement('span');
  swatch.className = 'hue-swatch';
  swatch.style.background = hueCss(sessionHue(session));
  swatch.title = 'Session color';

  const name = document.createElement('span');
  name.className = 'session-name';
  name.textContent = session.name || lastFolder(session.cwd) || session.sessionId;
  name.title = name.textContent;

  const age = document.createElement('span');
  age.className = 'session-age';
  age.textContent = formatAge(opts.now - session.statusChangedAt);

  head.append(dot, swatch, name);
  if (session.cwd) head.append(folderButton(session.cwd));
  if (session.cwd && opts.onOpenIn) head.append(openMenuButton(session.cwd, opts.onOpenIn));
  head.append(age);
  el.append(head);

  if (opts.expanded) {
    const details = document.createElement('div');
    details.className = 'session-details';
    details.append(detail('cwd', session.cwd), detail('session id', session.sessionId));
    el.append(details);
  }
  return el;
}
