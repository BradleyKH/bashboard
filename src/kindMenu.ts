import './kindMenu.css';
import { PANE_KINDS, type PaneKind } from './paneKinds';

let kindFilter: (kind: PaneKind) => boolean = () => true;

/** Decides which kinds the menu offers; the current pane's kind is always listed. */
export function setKindMenuFilter(filter: (kind: PaneKind) => boolean): void {
  kindFilter = filter;
}

/** Popup for changing a pane's kind (docs/design.md section 4.11). Only one is open at a time. */
class KindMenu {
  private menu: HTMLElement | null = null;
  private previousFocus: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  isOpen(): boolean {
    return this.menu !== null;
  }

  open(anchor: HTMLElement, current: PaneKind, onChoose: (kind: PaneKind) => void): void {
    this.close();
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const menu = document.createElement('div');
    menu.className = 'kind-menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;

    const items = PANE_KINDS.filter((info) => info.kind === current || kindFilter(info.kind)).map((info) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'kind-menu-item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(info.kind === current));
      if (info.kind === current) item.classList.add('current');

      const icon = document.createElement('span');
      icon.className = 'kind-menu-icon';
      icon.textContent = info.icon;
      const label = document.createElement('span');
      label.className = 'kind-menu-label';
      label.textContent = info.label;
      const mark = document.createElement('span');
      mark.className = 'kind-menu-mark';
      mark.textContent = info.kind === current ? '✓' : '';
      item.append(icon, label, mark);

      item.addEventListener('click', () => {
        this.close();
        if (info.kind !== current) onChoose(info.kind);
      });
      return item;
    });
    menu.append(...items);

    const move = (delta: number) => {
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
      items[next].focus();
    };
    menu.addEventListener('keydown', (e) => {
      // Keep keys away from the workspace keymap and xterm.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
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
    // xterm acts on keypress and keyup as well, so swallow those too.
    menu.addEventListener('keypress', (e) => e.stopPropagation());
    menu.addEventListener('keyup', (e) => e.stopPropagation());
    // Keeps focus on the menu while the pointer is down inside it.
    menu.addEventListener('mousedown', (e) => e.preventDefault());

    const onOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) this.close();
    };
    const onBlur = () => this.close();
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('blur', onBlur);
    this.cleanup = () => {
      document.removeEventListener('mousedown', onOutside, true);
      window.removeEventListener('blur', onBlur);
    };

    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - menu.offsetWidth))}px`;
    menu.style.top = `${rect.bottom + 2}px`;
    this.menu = menu;

    (items.find((i) => i.classList.contains('current')) ?? items[0]).focus();
  }

  close(): void {
    if (!this.menu) return;
    this.cleanup?.();
    this.cleanup = null;
    this.menu.remove();
    this.menu = null;
    const back = this.previousFocus;
    this.previousFocus = null;
    if (back?.isConnected) back.focus();
  }
}

export const kindMenu = new KindMenu();
