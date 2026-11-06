import { attachContextMenu } from './contextMenu';
import { copyPath, copyText } from './copyText';
import { formatAge, lastFolder } from './dashboardModel';
import { folderButton, openFolder } from './folderButton';
import { openInMenuItems, openMenuButton, type OpenInHandler } from './openMenu';
import { sessionRowMenuItems } from './paneCardMenus';
import type { Session, SessionStatus } from './sessions';
import { waitingText } from './terminalStatus';
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

/** One row in the dashboard's External sessions section (docs/design/dashboard.md section 4.6). */
export function renderSessionRow(session: Session, opts: SessionRowOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = 'session-row';
  el.classList.toggle('expanded', opts.expanded);
  el.dataset.sessionId = session.sessionId;

  const head = document.createElement('div');
  head.className = 'session-head';
  head.addEventListener('click', () => opts.onToggle(session.sessionId));
  attachContextMenu(head, async () => {
    const openItems = session.cwd && opts.onOpenIn ? await openInMenuItems(session.cwd, opts.onOpenIn) : [];
    return {
      target: head,
      entries: sessionRowMenuItems(session, openItems, {
        onOpenInExplorer: openFolder,
        onCopyPath: (path) => void copyPath(path),
        onCopyCwd: (cwd) => void copyText(cwd, 'cwd'),
        onCopySessionId: (id) => void copyText(id, 'session id'),
      }),
    };
  });

  const dot = document.createElement('span');
  dot.className = `status-dot ${DOT_CLASS[session.status]}`;
  const reason = session.status === 'waiting' ? waitingText(session.waitingReason) : null;
  dot.title = reason ?? session.rawStatus ?? session.status;


  const name = document.createElement('span');
  name.className = 'session-name';
  name.textContent = session.name || lastFolder(session.cwd) || session.sessionId;
  name.title = name.textContent;

  const age = document.createElement('span');
  age.className = 'session-age';
  age.textContent = formatAge(opts.now - session.statusChangedAt);

  head.append(dot, name);
  if (session.cwd) head.append(folderButton(session.cwd));
  if (session.cwd && opts.onOpenIn) head.append(openMenuButton(session.cwd, opts.onOpenIn));
  head.append(age);
  el.append(head);

  if (reason !== null) {
    const line = document.createElement('div');
    line.className = 'session-reason';
    line.textContent = reason;
    line.title = reason;
    el.append(line);
  }

  if (opts.expanded) {
    const details = document.createElement('div');
    details.className = 'session-details';
    details.append(detail('cwd', session.cwd), detail('session id', session.sessionId));
    el.append(details);
  }
  return el;
}
