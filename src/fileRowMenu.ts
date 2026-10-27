import type { FileEntry } from './filesModel';

export interface MoveTarget {
  label: string;
  path: string;
}

/** Each item reports the row's entry; the menu holds no app state. */
export interface FileRowMenuHandlers {
  openTerminalHere: (entry: FileEntry) => void;
  openInEditor: (entry: FileEntry) => void;
  copyPath: (entry: FileEntry) => void;
  insertPath: (entry: FileEntry) => void;
  /** `toDir` is the chosen target's absolute folder. */
  moveTo: (entry: FileEntry, toDir: string) => void;
  pin: (entry: FileEntry) => void;
}

/** Hover menu for a Files row (docs/design.md section 4.12). Only one is open at a time. */
export class FileRowMenu {
  private menu: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  isOpen(): boolean {
    return this.menu !== null;
  }

  /** Move to appears for files only (`fs_move` moves files) and only when there are targets. */
  open(anchor: HTMLElement, entry: FileEntry, handlers: FileRowMenuHandlers, moveTargets: readonly MoveTarget[]): void {
    this.close();
    const menu = document.createElement('div');
    menu.className = 'file-menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;

    const choose = (fn: () => void) => () => {
      this.close();
      fn();
    };
    const item = (label: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'file-menu-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };

    const items: HTMLElement[] = [];
    if (entry.isDir) items.push(item('Open terminal here', choose(() => handlers.openTerminalHere(entry))));
    items.push(item('Open in editor', choose(() => handlers.openInEditor(entry))));
    items.push(item('Copy path', choose(() => handlers.copyPath(entry))));
    items.push(item('Insert path', choose(() => handlers.insertPath(entry))));

    if (!entry.isDir && moveTargets.length > 0) {
      const sub = document.createElement('div');
      sub.className = 'file-menu-sub';
      sub.hidden = true;
      for (const t of moveTargets) {
        sub.append(item(t.label, choose(() => handlers.moveTo(entry, t.path))));
      }
      const toggle = item('Move to ▸', () => {
        sub.hidden = !sub.hidden;
      });
      items.push(toggle, sub);
    }
    items.push(item('Pin', choose(() => handlers.pin(entry))));
    menu.append(...items);

    menu.addEventListener('keydown', (e) => {
      // Keep keys away from the workspace keymap.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    menu.addEventListener('keypress', (e) => e.stopPropagation());
    menu.addEventListener('keyup', (e) => e.stopPropagation());
    menu.addEventListener('mousedown', (e) => e.preventDefault());

    const onOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && e.target !== anchor) this.close();
    };
    const onBlur = () => this.close();
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('blur', onBlur);
    this.cleanup = () => {
      document.removeEventListener('mousedown', onOutside, true);
      window.removeEventListener('blur', onBlur);
    };

    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(r.right - m.width, window.innerWidth - m.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(r.bottom + 2, window.innerHeight - m.height - 4))}px`;
    this.menu = menu;
    menu.focus();
  }

  close(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.menu?.remove();
    this.menu = null;
  }
}
