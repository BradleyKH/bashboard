import './openMenu.css';
import { closeContextMenu, contextMenuGeneration, isContextMenuOpenFor, openContextMenu } from './contextMenu';
import { item, type MenuItem } from './contextMenuModel';
import { iconButton } from './rowControls';

/** What the Open menu can open a row's repo as (docs/design.md section 4.6). */
export type OpenInKind = 'terminal' | 'files' | 'git' | 'search' | 'editor';

export type OpenInHandler = (kind: OpenInKind, path: string) => void;

/** Menu entries in display order. */
const ITEMS: { kind: OpenInKind; label: string }[] = [
  { kind: 'terminal', label: 'Terminal' },
  { kind: 'files', label: 'Files' },
  { kind: 'git', label: 'Git' },
  { kind: 'search', label: 'Search' },
  { kind: 'editor', label: 'Editor' },
];

let gitProbe: (path: string) => Promise<boolean> = () => Promise.resolve(false);

/** Decides whether a row's path is in a git repo, which the Git entry needs to be listed. */
export function setOpenMenuGitProbe(probe: (path: string) => Promise<boolean>): void {
  gitProbe = probe;
}

/** The Open menu's entries for `path`; Git is listed only when `isGit`. */
export function openInItems(path: string, isGit: boolean, onOpenIn: OpenInHandler): MenuItem[] {
  return ITEMS.filter(({ kind }) => kind !== 'git' || isGit).map(({ kind, label }) =>
    item(label, () => onOpenIn(kind, path)),
  );
}

/** `openInItems` after the git probe; a probe failure counts as not git. */
export async function openInMenuItems(path: string, onOpenIn: OpenInHandler): Promise<MenuItem[]> {
  let isGit = false;
  try {
    isGit = await gitProbe(path);
  } catch {
    isGit = false;
  }
  return openInItems(path, isGit, onOpenIn);
}

/** The dashboard rows' Open menu button, placed beside the folder button. */
export function openMenuButton(path: string, onOpenIn: OpenInHandler): HTMLButtonElement {
  const button = iconButton('▾', 'open-menu-button', 'Open in...', () => {
    if (isContextMenuOpenFor(button)) {
      closeContextMenu();
      return;
    }
    // Opening or closing any menu while the probe runs makes this one stale.
    const generation = contextMenuGeneration();
    void openInMenuItems(path, onOpenIn).then((items) => {
      if (generation !== contextMenuGeneration()) return;
      openContextMenu(items, { anchorEl: button, align: 'left' });
    });
  });
  return button;
}
