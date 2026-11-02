import { attachContextMenu } from './contextMenu';
import { copyPath } from './copyText';
import { displayPath } from './displayPath';
import { folderButton, openFolder } from './folderButton';
import { openInItems, openInMenuItems, openMenuButton, type OpenInHandler } from './openMenu';
import { worktreeRowMenuItems } from './repoMenus';
import type { Worktree } from './worktreeApi';
import { countsText, worktreeBadge } from './worktreeModel';

export interface WorktreeRowOptions {
  focused: boolean;
  expanded: boolean;
  onToggle(): void;
  onOpenIn: OpenInHandler;
  /** Starts the same delete the detail's Delete button runs. */
  onDelete(): void;
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

/** One worktree in the Repo section's list (docs/design.md section 4.6); a click expands it. */
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

  attachContextMenu(el, async () => {
    // A missing folder has nothing to probe, and every Open entry is disabled for it.
    const openItems = w.prunable
      ? openInItems(w.path, false, opts.onOpenIn)
      : await openInMenuItems(w.path, opts.onOpenIn);
    return {
      entries: worktreeRowMenuItems({ missing: w.prunable, locked: w.locked }, openItems, {
        openInExplorer: () => openFolder(w.path),
        copyPath: () => void copyPath(w.path),
        delete: w.main ? undefined : opts.onDelete,
      }),
      target: el,
    };
  });
  return el;
}
