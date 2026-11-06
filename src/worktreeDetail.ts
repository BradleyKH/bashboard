import { relativeTime } from './gitModel';
import type { Worktree, WorktreeDetail } from './worktreeApi';
import { countsText, mergedText, upstreamText, workingTreeText } from './worktreeModel';

export interface WorktreeDetailOptions {
  loading: boolean;
  error?: string;
  /** A refusal or git's output from Delete. */
  message?: string;
}

function line(label: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'worktree-detail-line';
  const l = document.createElement('span');
  l.className = 'worktree-detail-label';
  l.textContent = label;
  const t = document.createElement('span');
  t.className = 'worktree-detail-text';
  t.textContent = text;
  t.title = text;
  el.append(l, t);
  return el;
}

function note(className: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function statusLines(w: Worktree, detail: WorktreeDetail): HTMLElement[] {
  const head = detail.head
    ? `${detail.head.subject} (${detail.head.hash}, ${relativeTime(detail.head.time, Date.now())})`
    : 'No commits';
  const counts = countsText(detail.ahead, detail.behind);
  // The main worktree is the primary branch's own checkout (or at least never reported merged), so only its counts show.
  const against = detail.comparison
    ? `${counts ? `${counts} ${detail.comparison}` : ''}${
        w.main ? '' : `${counts ? ' · ' : ''}${mergedText(detail.merged, detail.comparison, detail.upstream)}`
      }`
    : w.main
      ? ''
      : mergedText('unknown', null, null);
  return [
    line('Head', head),
    ...(against ? [line('Against primary', against)] : []),
    line('Upstream', upstreamText(detail)),
    line('Working tree', workingTreeText(detail)),
  ];
}

/** The expanded part of a worktree row in the Git pane's Branches tab (docs/design/git.md section 4.13). */
export function renderWorktreeDetail(
  w: Worktree,
  detail: WorktreeDetail | null,
  opts: WorktreeDetailOptions,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'worktree-detail';
  // The detail sits under its row; a click in it must not collapse the row.
  el.addEventListener('click', (e) => e.stopPropagation());

  if (w.prunable) el.append(note('worktree-detail-note', 'Folder missing'));
  else if (opts.error) el.append(note('worktree-detail-note error', opts.error));
  else if (detail) el.append(...statusLines(w, detail));
  else if (opts.loading) el.append(note('worktree-detail-note', 'Loading...'));

  if (opts.message) {
    const msg = document.createElement('pre');
    msg.className = 'worktree-message';
    msg.textContent = opts.message;
    el.append(msg);
  }
  return el;
}
