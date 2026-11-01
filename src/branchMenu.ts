import './branchMenu.css';

export interface BranchMenuItem {
  label: string;
  checked: boolean;
  onPick: () => void;
}

let closeOpen: (() => void) | null = null;

/** A popup list of choices under `anchor`, one marked with a check (docs/v0.2.0-design.md section 4.1). */
export function openBranchMenu(anchor: HTMLElement, items: BranchMenuItem[]): void {
  // A second press on the anchor closes its menu; the press itself is left to this click.
  const toggledOff = anchor.classList.contains('open') && closeOpen !== null;
  closeOpen?.();
  if (toggledOff || items.length === 0) return;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const menu = document.createElement('div');
  menu.className = 'branch-menu';
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
    // A press on the anchor is left to its click.
    const target = e.target as Node;
    if (!menu.contains(target) && !anchor.contains(target)) close();
  };

  const buttons = items.map(({ label, checked, onPick }) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'branch-menu-item';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(checked));
    const mark = document.createElement('span');
    mark.className = 'branch-menu-check';
    mark.textContent = checked ? '✓' : '';
    const text = document.createElement('span');
    text.className = 'branch-menu-label';
    text.textContent = label;
    item.append(mark, text);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      onPick();
    });
    return item;
  });
  menu.append(...buttons);

  const move = (delta: number): void => {
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = at < 0 ? (delta > 0 ? 0 : buttons.length - 1) : (at + delta + buttons.length) % buttons.length;
    buttons[next].focus();
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
  const below = rect.bottom + 2;
  // Flip above the anchor when the menu would run off the bottom and there is more room above.
  const flip = below + menu.offsetHeight > window.innerHeight && rect.top > window.innerHeight - below;
  const top = flip ? Math.max(0, rect.top - 2 - menu.offsetHeight) : below;
  menu.style.top = `${top}px`;
  menu.style.maxHeight = `${Math.max(80, window.innerHeight - top - 8)}px`;
  (buttons.find((b) => b.getAttribute('aria-checked') === 'true') ?? buttons[0]).focus();
}
