import { openFolder } from './folderButton';
import { relativeTime } from './gitModel';
import type { OpenInHandler, OpenInKind } from './openMenu';
import type { Worktree, WorktreeDetail } from './worktreeApi';
import { countsText, mergedText, upstreamText, workingTreeText } from './worktreeModel';

export interface WorktreeDetailOptions {
  loading: boolean;
  error?: string;
  /** A refusal or git's output from Delete. */
  message?: string;
  onOpenIn: OpenInHandler;
  onDelete(): void;
}

const OPEN_ACTIONS: { kind: OpenInKind; label: string }[] = [
  { kind: 'terminal', label: 'Terminal' },
  { kind: 'files', label: 'Files' },
  { kind: 'git', label: 'Git' },
  { kind: 'editor', label: 'Editor' },
];

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

function action(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'worktree-action';
  b.textContent = label;
  b.addEventListener('click', run);
  return b;
}

function statusLines(detail: WorktreeDetail): HTMLElement[] {
  const head = detail.head
    ? `${detail.head.subject} (${detail.head.hash}, ${relativeTime(detail.head.time, Date.now())})`
    : 'No commits';
  const counts = countsText(detail.ahead, detail.behind);
  const against = detail.comparison
    ? `${counts ? `${counts} ${detail.comparison} · ` : ''}${mergedText(detail.merged, detail.comparison, detail.upstream)}`
    : mergedText('unknown', null, null);
  return [
    line('Head', head),
    line('Against primary', against),
    line('Upstream', upstreamText(detail)),
    line('Working tree', workingTreeText(detail)),
  ];
}

/** The expanded part of a worktree row (docs/v0.2.0-design.md section 4.2). */
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
  else if (detail) el.append(...statusLines(detail));
  else if (opts.loading) el.append(note('worktree-detail-note', 'Loading...'));

  const actions = document.createElement('div');
  actions.className = 'worktree-actions';
  if (!w.prunable) {
    actions.append(
      ...OPEN_ACTIONS.map(({ kind, label }) => action(label, () => opts.onOpenIn(kind, w.path))),
      action('Open in File Explorer', () => openFolder(w.path)),
    );
  }
  if (!w.main) {
    const del = action('Delete', () => opts.onDelete());
    del.classList.add('danger');
    if (w.locked) {
      del.disabled = true;
      del.title = w.lockReason ? `Locked: ${w.lockReason}` : 'The worktree is locked';
    }
    actions.append(del);
  }
  if (actions.childElementCount > 0) el.append(actions);

  if (opts.message) {
    const msg = document.createElement('pre');
    msg.className = 'worktree-message';
    msg.textContent = opts.message;
    el.append(msg);
  }
  return el;
}
