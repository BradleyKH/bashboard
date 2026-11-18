import { agentName } from './agentNames';
import type { AgentId } from './agentTable';
import { copyText } from './copyText';
import { item, separator, type MenuEntry } from './contextMenuModel';
import { displayPath } from './displayPath';
import { openFolder } from './folderButton';
import { fileManagerName } from './platform';
import { relativeTime, resumeCommandText, type HistoryRow } from './sessionHistoryModel';

/** The short tag on a row; the tooltip carries the full name. */
export const AGENT_BADGES: Record<AgentId, string> = { claude: 'CC', codex: 'CX', copilot: 'CP' };

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * One row of the Sessions dialog (docs/design/sessions.md section 4.32). It carries no listeners;
 * the dialog delegates clicks and the context menu from the list. `index` is its place in the
 * list the dialog is showing, which the delegate reads back.
 */
export function sessionRow(
  row: HistoryRow,
  index: number,
  selected: boolean,
  now: number,
  resumable: boolean,
  showBadge: boolean,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sessions-row';
  el.classList.toggle('selected', selected);
  el.classList.toggle('sessions-row-disabled', !resumable);
  el.dataset.index = String(index);
  el.dataset.key = `${row.agent}:${row.sessionId}`;
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', String(selected));
  el.title = `${row.title}\n${row.cwd}`;
  if (!resumable) el.title += "\nThis session's id is not safe to resume from here.";

  const top = document.createElement('div');
  top.className = 'sessions-row-top';
  if (row.live) {
    const dot = span('sessions-live', '');
    dot.title = 'Running now';
    dot.setAttribute('aria-label', 'Running now');
    top.append(dot);
  }
  const time = span('sessions-time', relativeTime(row.updatedAt, now));
  time.title = new Date(row.updatedAt).toLocaleString();
  top.append(span('sessions-title', row.title), time);

  const meta = document.createElement('div');
  meta.className = 'sessions-row-meta';
  if (showBadge) {
    const badge = span('sessions-badge', AGENT_BADGES[row.agent]);
    badge.title = agentName(row.agent);
    meta.append(badge);
  }
  meta.append(span('sessions-folder', displayPath(row.cwd)));
  if (row.branch) meta.append(span('sessions-branch', row.branch));
  if (!row.cwdExists) meta.append(span('sessions-missing', 'folder missing'));

  el.append(top, meta);
  return el;
}

/** The right-click menu for a row; `resume` is null when the session cannot be resumed. */
export function sessionRowMenu(row: HistoryRow, resume: (() => void) | null): MenuEntry[] {
  const command = resumeCommandText(row);
  return [
    item('Resume', resume ?? (() => {}), { enabled: resume !== null }),
    separator(),
    item('Copy session id', () => void copyText(row.sessionId, 'session id')),
    item('Copy resume command', () => void copyText(command ?? '', 'resume command'), { enabled: command !== null }),
    separator(),
    item(`Open folder in ${fileManagerName()}`, () => openFolder(row.cwd), { enabled: row.cwdExists }),
  ];
}
