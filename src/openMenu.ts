import './openMenu.css';
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

let closeOpen: (() => void) | null = null;
let gitProbe: (path: string) => Promise<boolean> = () => Promise.resolve(false);

/** Decides whether a row's path is in a git repo, which the Git entry needs to be listed. */
export function setOpenMenuGitProbe(probe: (path: string) => Promise<boolean>): void {
  gitProbe = probe;
}

function openMenu(anchor: HTMLElement, path: string, onOpenIn: OpenInHandler): void {
  closeOpen?.();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const menu = document.createElement('div');
  menu.className = 'open-menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;

  const close = (): void => {
    if (closeOpen !== close) return;
    closeOpen = null;
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('blur', close);
    menu.remove();
    anchor.classList.remove('open');
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const onOutside = (e: MouseEvent): void => {
    // A press on the anchor is left to its click, which toggles the menu.
    const target = e.target as Node;
    if (!menu.contains(target) && !anchor.contains(target)) close();
  };

  const all = ITEMS.map(({ kind, label }) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'open-menu-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.hidden = kind === 'git';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      onOpenIn(kind, path);
    });
    return item;
  });
  menu.append(...all);
  let items = all.filter((i) => !i.hidden);
  const gitItem = all[ITEMS.findIndex((i) => i.kind === 'git')];
  void gitProbe(path).then((isGit) => {
    if (!isGit || closeOpen !== close) return;
    gitItem.hidden = false;
    items = all.filter((i) => !i.hidden);
  });

  const move = (delta: number): void => {
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
    items[next].focus();
  };
  menu.addEventListener('keydown', (e) => {
    // Keep keys away from the workspace keymap and xterm.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  });
  menu.addEventListener('keypress', (e) => e.stopPropagation());
  menu.addEventListener('keyup', (e) => e.stopPropagation());
  // Keeps focus on the menu while the pointer is down inside it.
  menu.addEventListener('mousedown', (e) => e.preventDefault());

  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('blur', close);
  closeOpen = close;

  document.body.append(menu);
  anchor.classList.add('open');
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - menu.offsetWidth))}px`;
  menu.style.top = `${rect.bottom + 2}px`;
  items[0].focus();
}

/** The dashboard rows' Open menu button, placed beside the folder button. */
export function openMenuButton(path: string, onOpenIn: OpenInHandler): HTMLButtonElement {
  const button = iconButton('▾', 'open-menu-button', 'Open in...', () => {
    if (button.classList.contains('open')) closeOpen?.();
    else openMenu(button, path, onOpenIn);
  });
  return button;
}
