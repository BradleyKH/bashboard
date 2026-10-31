import { displayPath } from './displayPath';
import { folderButton } from './folderButton';
import { openMenuButton, type OpenInHandler } from './openMenu';
import type { Worktree } from './worktreeApi';
import { countsText, worktreeBadge } from './worktreeModel';

export interface WorktreeRowOptions {
  focused: boolean;
  expanded: boolean;
  onToggle(): void;
  onOpenIn: OpenInHandler;
}

function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

/** One worktree in the Repo section's list (docs/v0.2.0-design.md section 4.1); a click expands it. */
export function renderWorktreeRow(w: Worktree, opts: WorktreeRowOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = 'worktree-row';
  el.classList.toggle('focused', opts.focused);
  el.classList.toggle('expanded', opts.expanded);
  el.classList.toggle('missing', w.prunable);
  el.dataset.worktreePath = w.path;
  el.setAttribute('aria-expanded', String(opts.expanded));
  el.addEventListener('click', () => opts.onToggle());

  const name = span('worktree-name', folderName(w.path));
  name.title = displayPath(w.path);
  const branch = span('worktree-branch', w.branch ?? w.head?.slice(0, 7) ?? '');
  if (!w.branch) branch.classList.add('detached');
  const parts: HTMLElement[] = [name, branch];

  const counts = countsText(w.ahead, w.behind);
  if (counts) parts.push(span('worktree-counts', counts));
  const badge = worktreeBadge(w);
  if (badge) {
    const pill = span('worktree-badge', badge);
    pill.dataset.badge = badge.toLowerCase().replace(/ /g, '-');
    if (badge === 'Locked' && w.lockReason) pill.title = w.lockReason;
    parts.push(pill);
  }
  // A missing folder has nothing to open.
  if (!w.prunable) parts.push(folderButton(w.path), openMenuButton(w.path, opts.onOpenIn));
  el.append(...parts);
  return el;
}
