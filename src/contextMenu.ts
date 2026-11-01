import './contextMenu.css';
import {
  isEnabled,
  isKeyboardContextMenu,
  type MenuEntry,
  type MenuPosition,
  type MenuSubmenu,
  nextEnabled,
  placeMenu,
  placeSubmenu,
  type Size,
  tidySeparators,
} from './contextMenuModel';

/** Where a menu opens: at a pointer, or below an element with its left or right edge aligned. */
export type ContextMenuAt = { x: number; y: number } | { anchorEl: HTMLElement; align?: 'left' | 'right' };

export interface ContextMenuOptions {
  /** Outlined with `menu-target` while the menu is open; never selected. */
  target?: HTMLElement | null;
  /** Runs after the menu closes, whatever closed it. */
  onClose?: () => void;
}

/** What an owner's build returns to open a menu; `target` is outlined and anchors a keyboard open. */
export interface ContextMenuSpec {
  entries: MenuEntry[];
  target?: HTMLElement | null;
}

export type ContextMenuBuild = (
  e: MouseEvent,
  keyboard: boolean,
) => ContextMenuSpec | null | Promise<ContextMenuSpec | null>;

interface OpenMenu {
  close: () => void;
  anchorEl: HTMLElement | null;
}

let current: OpenMenu | null = null;
// Bumped by every open and close, so a menu built asynchronously opens only if nothing else
// happened to menus while it was pending.
let generation = 0;

/** Changes whenever a menu opens or closes; compare across an await to drop a stale menu. */
export function contextMenuGeneration(): number {
  return generation;
}

/** Closes the open menu, if any. */
export function closeContextMenu(): void {
  current?.close();
}

/** Whether the open menu was opened anchored at `el`, so a button can toggle it. */
export function isContextMenuOpenFor(el: HTMLElement): boolean {
  return current !== null && current.anchorEl === el;
}

/**
 * Whether a field's blur only moved focus into a menu, as its own text field menu does; the menu
 * hands focus back when it closes, so a field that ends on blur should stay open.
 */
export function isBlurIntoContextMenu(e: FocusEvent): boolean {
  return e.relatedTarget instanceof Element && e.relatedTarget.closest('.context-menu') !== null;
}

/**
 * Opens `entries` as the one open menu (docs/v0.2.0-design.md section 11.2), closing any other.
 * An empty list (after tidying separators) opens nothing.
 */
export function openContextMenu(entries: MenuEntry[], at: ContextMenuAt, opts: ContextMenuOptions = {}): void {
  if ('anchorEl' in at) {
    const anchorEl = at.anchorEl;
    const align = at.align ?? 'left';
    show(entries, (size, view) => placeMenu(size, { anchor: anchorEl.getBoundingClientRect(), align }, view), {
      ...opts,
      anchorEl,
      focusFirst: true,
    });
  } else {
    show(entries, (size, view) => placeMenu(size, at, view), { ...opts, anchorEl: null, focusFirst: false });
  }
}

/**
 * Gives `el` a right-click menu. Events from inside a terminal or on a text field are left alone
 * (the text field menu takes those as they bubble to `document`). A null build lets the event
 * bubble so an outer owner can offer its menu; anything else stops it here, so the innermost
 * element with a menu wins. Returns a function that detaches the listener.
 */
export function attachContextMenu(el: HTMLElement, build: ContextMenuBuild): () => void {
  const onContextMenu = (e: MouseEvent): void => {
    const origin = e.target instanceof Element ? e.target : null;
    if (origin?.closest('.xterm')) return;
    if (origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement) return;

    const keyboard = isKeyboardContextMenu(e as MouseEvent & { pointerType?: string });
    const open = (spec: ContextMenuSpec): void => {
      const target = spec.target ?? null;
      if (keyboard) {
        const anchor = target ?? (origin instanceof HTMLElement ? origin : el);
        const place: Place = (size, view) =>
          placeMenu(size, { anchor: anchor.getBoundingClientRect(), align: 'left' }, view);
        show(spec.entries, place, { target, anchorEl: null, focusFirst: true });
      } else {
        const place: Place = (size, view) => placeMenu(size, { x: e.clientX, y: e.clientY }, view);
        show(spec.entries, place, { target, anchorEl: null, focusFirst: false });
      }
    };

    const result = build(e, keyboard);
    if (result === null) return;
    if (result instanceof Promise) {
      e.preventDefault();
      e.stopPropagation();
      const pendingFrom = generation;
      result.then(
        (spec) => {
          if (spec && generation === pendingFrom) open(spec);
        },
        (err) => console.error('context menu build failed', err),
      );
      return;
    }
    if (tidySeparators(result.entries).length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    open(result);
  };
  el.addEventListener('contextmenu', onContextMenu);
  return () => el.removeEventListener('contextmenu', onContextMenu);
}

interface ShowOptions extends ContextMenuOptions {
  /** The element whose `open` class shows the menu and whose own press toggles it. */
  anchorEl: HTMLElement | null;
  /** Focus the checked or first enabled item, as for a button or key; else the menu itself. */
  focusFirst: boolean;
}

type Place = (size: Size, viewport: Size) => MenuPosition;

interface MenuList {
  el: HTMLElement;
  entries: MenuEntry[];
  /** Parallel to `entries`; null for separators. */
  buttons: (HTMLButtonElement | null)[];
}

function viewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

// Rounded up: offsetHeight truncates a fractional height, and a maxHeight a pixel short of the
// content shows a scrollbar that also widens the menu after it is placed.
function measure(el: HTMLElement): Size {
  const r = el.getBoundingClientRect();
  return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
}

function position(el: HTMLElement, pos: MenuPosition): void {
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
  el.style.maxHeight = `${pos.maxHeight}px`;
}

function swallowKeys(el: HTMLElement): void {
  // xterm.js acts on the keypress that follows a keydown, and on keyup, so all three stop here.
  el.addEventListener('keypress', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
  // Keeps focus where it is while the pointer is down inside the menu.
  el.addEventListener('mousedown', (e) => e.preventDefault());
}

function renderList(entries: MenuEntry[], className: string): MenuList {
  const el = document.createElement('div');
  el.className = className;
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  const buttons = entries.map((entry) => {
    if (entry.kind === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      sep.setAttribute('role', 'separator');
      el.append(sep);
      return null;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-menu-item';
    button.tabIndex = -1;
    const checked = entry.kind === 'item' ? entry.checked : undefined;
    if (checked !== undefined) {
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(checked));
    } else {
      button.setAttribute('role', 'menuitem');
    }
    if (!isEnabled(entry)) button.setAttribute('aria-disabled', 'true');
    if (entry.kind === 'submenu') button.setAttribute('aria-haspopup', 'menu');

    const icon = document.createElement('span');
    icon.className = 'context-menu-icon';
    icon.textContent = entry.kind === 'item' ? (entry.icon ?? '') : '';
    const label = document.createElement('span');
    label.className = 'context-menu-label';
    label.textContent = entry.label;
    const mark = document.createElement('span');
    mark.className = 'context-menu-mark';
    mark.textContent = entry.kind === 'submenu' ? '▸' : checked ? '✓' : '';
    button.append(icon, label, mark);
    el.append(button);
    return button;
  });
  return { el, entries, buttons };
}

function show(raw: MenuEntry[], place: Place, opts: ShowOptions): void {
  closeContextMenu();
  const entries = tidySeparators(raw);
  if (entries.length === 0) return;
  generation++;

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = renderList(entries, 'context-menu');
  let sub: (MenuList & { parentIndex: number }) | null = null;

  const inside = (node: Node): boolean => root.el.contains(node) || (sub?.el.contains(node) ?? false);

  const closeSubmenu = (refocusParent: boolean): void => {
    if (!sub) return;
    const parent = root.buttons[sub.parentIndex];
    sub.el.remove();
    sub = null;
    if (refocusParent) parent?.focus();
  };

  const openSubmenu = (index: number, focusFirst: boolean): void => {
    const entry = entries[index] as MenuSubmenu;
    if (sub?.parentIndex !== index) {
      closeSubmenu(false);
      const list = renderList(entry.items, 'context-menu context-menu-sub');
      wire(list, true);
      sub = { ...list, parentIndex: index };
      document.body.append(list.el);
      const parentRect = root.buttons[index]!.getBoundingClientRect();
      position(list.el, placeSubmenu(measure(list.el), parentRect, viewport()));
    }
    if (focusFirst) {
      const first = nextEnabled(sub!.entries, -1, 1);
      if (first >= 0) sub!.buttons[first]?.focus();
    }
  };

  const choose = (list: MenuList, index: number, isSub: boolean): void => {
    const entry = list.entries[index];
    if (!isEnabled(entry)) return;
    if (entry.kind === 'submenu') {
      if (!isSub) openSubmenu(index, true);
      return;
    }
    if (entry.kind === 'item') {
      close();
      entry.run();
    }
  };

  function wire(list: MenuList, isSub: boolean): void {
    swallowKeys(list.el);
    list.buttons.forEach((button, index) => {
      if (!button) return;
      const entry = list.entries[index];
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        choose(list, index, isSub);
      });
      button.addEventListener('mouseenter', () => {
        if (!isEnabled(entry)) return;
        button.focus();
        if (isSub) return;
        if (entry.kind === 'submenu') openSubmenu(index, false);
        else closeSubmenu(false);
      });
    });
    list.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const at = list.buttons.indexOf(document.activeElement as HTMLButtonElement);
      const focus = (index: number): void => {
        if (index >= 0) list.buttons[index]?.focus();
      };
      switch (e.key) {
        case 'ArrowDown':
          focus(nextEnabled(list.entries, at, 1));
          break;
        case 'ArrowUp':
          focus(nextEnabled(list.entries, at, -1));
          break;
        case 'Home':
          focus(nextEnabled(list.entries, -1, 1));
          break;
        case 'End':
          focus(nextEnabled(list.entries, -1, -1));
          break;
        case 'Enter':
        case ' ':
          if (at >= 0) choose(list, at, isSub);
          break;
        case 'ArrowRight':
          if (!isSub && at >= 0 && list.entries[at].kind === 'submenu' && isEnabled(list.entries[at])) {
            openSubmenu(at, true);
          }
          break;
        case 'ArrowLeft':
          if (isSub) closeSubmenu(true);
          break;
        case 'Escape':
          close();
          break;
        case 'Tab':
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  const onOutside = (e: MouseEvent): void => {
    const node = e.target as Node;
    // A press on the anchor is left to its own click, so a button toggles its menu.
    if (inside(node) || opts.anchorEl?.contains(node)) return;
    close();
  };

  const self: OpenMenu = { close: () => close(), anchorEl: opts.anchorEl };
  function close(): void {
    if (current !== self) return;
    current = null;
    generation++;
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('blur', close);
    closeSubmenu(false);
    root.el.remove();
    opts.target?.classList.remove('menu-target');
    opts.anchorEl?.classList.remove('open');
    if (previousFocus?.isConnected) previousFocus.focus();
    opts.onClose?.();
  }

  wire(root, false);
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('blur', close);
  current = self;

  document.body.append(root.el);
  position(root.el, place(measure(root.el), viewport()));
  opts.target?.classList.add('menu-target');
  opts.anchorEl?.classList.add('open');

  const checked = entries.findIndex((entry) => entry.kind === 'item' && entry.checked && isEnabled(entry));
  const first = opts.focusFirst ? (checked >= 0 ? checked : nextEnabled(entries, -1, 1)) : -1;
  (root.buttons[first] ?? root.el).focus();
}
