/** One choosable row in a context menu (docs/design.md section 4.4). */
export interface MenuItem {
  kind: 'item';
  label: string;
  run: () => void;
  /** Defaults to true. */
  enabled?: boolean;
  /** Set (true or false) to draw the item as a radio choice with a check-mark column. */
  checked?: boolean;
  icon?: string;
}

export interface MenuSeparator {
  kind: 'separator';
}

/** What a submenu may hold: menus nest one level only. */
export type MenuLeaf = MenuItem | MenuSeparator;

export interface MenuSubmenu {
  kind: 'submenu';
  label: string;
  items: MenuLeaf[];
  /** Defaults to true; a submenu with no enabled items is disabled by `tidySeparators`. */
  enabled?: boolean;
}

export type MenuEntry = MenuItem | MenuSeparator | MenuSubmenu;

export interface MenuItemOptions {
  enabled?: boolean;
  checked?: boolean;
  icon?: string;
}

export function item(label: string, run: () => void, opts: MenuItemOptions = {}): MenuItem {
  return { kind: 'item', label, run, ...opts };
}

export function separator(): MenuSeparator {
  return { kind: 'separator' };
}

export function submenu(label: string, items: MenuLeaf[], opts: { enabled?: boolean } = {}): MenuSubmenu {
  return { kind: 'submenu', label, items, ...opts };
}

/** Whether `entry` can be focused and chosen. */
export function isEnabled(entry: MenuEntry): boolean {
  return entry.kind !== 'separator' && entry.enabled !== false;
}

function tidyList<T extends MenuEntry>(entries: T[]): T[] {
  const out: T[] = [];
  for (const entry of entries) {
    if (entry.kind === 'separator' && (out.length === 0 || out[out.length - 1].kind === 'separator')) continue;
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1].kind === 'separator') out.pop();
  return out;
}

/**
 * Drops leading, trailing, and doubled separators (in submenus too), so builders can append
 * groups conditionally, and disables a submenu with no enabled items.
 */
export function tidySeparators(entries: MenuEntry[]): MenuEntry[] {
  return tidyList(entries).map((entry) => {
    if (entry.kind !== 'submenu') return entry;
    const items = tidyList(entry.items);
    const enabled = entry.enabled !== false && items.some(isEnabled);
    return { ...entry, items, enabled };
  });
}

/**
 * Index of the next enabled, non-separator entry after `from`, stepping by `delta` (1 or -1) and
 * wrapping; -1 when there is none. A negative `from` starts before the first entry going down
 * and after the last going up, which is how Home and End use it.
 */
export function nextEnabled(entries: readonly MenuEntry[], from: number, delta: number): number {
  const n = entries.length;
  if (n === 0) return -1;
  const start = from < 0 ? (delta > 0 ? -1 : n) : from;
  for (let i = 1; i <= n; i++) {
    const at = (((start + delta * i) % n) + n) % n;
    if (isEnabled(entries[at])) return at;
  }
  return -1;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type MenuPlacementAt = { x: number; y: number } | { anchor: Rect; align: 'left' | 'right' };

export interface MenuPosition {
  left: number;
  top: number;
  maxHeight: number;
}

/** Space between an anchor and the menu opened under it. */
const ANCHOR_GAP = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Where a menu of `size` goes in `viewport`: at a pointer, or below an anchor with its left or
 * right edge aligned. Flips above when there is room there and none below, shifts left from the
 * right edge, and clamps to `margin` at every edge. A menu taller than the viewport gets a
 * `maxHeight` and scrolls.
 */
export function placeMenu(size: Size, at: MenuPlacementAt, viewport: Size, margin = 4): MenuPosition {
  const maxHeight = Math.min(size.height, Math.max(0, viewport.height - 2 * margin));
  const height = maxHeight;
  const bottomLimit = viewport.height - margin;

  let left: number;
  let below: number;
  let above: number;
  if ('anchor' in at) {
    left = at.align === 'right' ? at.anchor.right - size.width : at.anchor.left;
    below = at.anchor.bottom + ANCHOR_GAP;
    above = at.anchor.top - ANCHOR_GAP - height;
  } else {
    left = at.x;
    below = at.y;
    above = at.y - height;
  }
  // With room on neither side, clamping the below position slides the menu up just enough to fit.
  const top = below + height <= bottomLimit || above < margin ? below : above;

  return {
    left: clamp(left, margin, viewport.width - margin - size.width),
    top: clamp(top, margin, bottomLimit - height),
    maxHeight,
  };
}

/**
 * Where a submenu of `size` goes beside its parent item: to the right, or to the left when there
 * is no room on the right, clamped vertically.
 */
export function placeSubmenu(size: Size, parentItemRect: Rect, viewport: Size, margin = 4): MenuPosition {
  const maxHeight = Math.min(size.height, Math.max(0, viewport.height - 2 * margin));
  const rightEdge = viewport.width - margin;
  const left =
    parentItemRect.right + size.width <= rightEdge ? parentItemRect.right : parentItemRect.left - size.width;
  return {
    left: clamp(left, margin, rightEdge - size.width),
    top: clamp(parentItemRect.top, margin, viewport.height - margin - maxHeight),
    maxHeight,
  };
}

/** How long after a menu key's keydown a `contextmenu` event still counts as that key's. */
export const MENU_KEY_WINDOW_MS = 500;

/** Whether a keydown is the Menu (Apps) key or Shift+F10, the keyboard ways to ask for a context menu. */
export function isMenuKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  if (e.key === 'ContextMenu') return true;
  return e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey;
}

/**
 * Whether a `contextmenu` event came from the Menu key or Shift+F10 rather than a right-click.
 * A menu keydown just before it (`lastMenuKeyAt`, same clock as `timeStamp`) is decisive, since
 * WebView2 has delivered Shift+F10 as `button` -1 with `pointerType` "mouse". Without one, the
 * fields decide: the keys normally arrive with `button` 0 and an empty `pointerType`, while a
 * right-click has `button` 2.
 */
export function isKeyboardContextMenu(
  e: { button: number; pointerType?: string; timeStamp?: number },
  lastMenuKeyAt: number | null = null,
): boolean {
  if (e.button === 2) return false;
  if (lastMenuKeyAt !== null && e.timeStamp !== undefined) {
    const elapsed = e.timeStamp - lastMenuKeyAt;
    if (elapsed >= 0 && elapsed <= MENU_KEY_WINDOW_MS) return true;
  }
  return e.button !== 2 && !e.pointerType;
}
