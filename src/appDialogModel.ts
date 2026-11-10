/** The tabs of the app dialog, left to right (docs/design/app.md section 4.18). */
export const DIALOG_TABS = ['help', 'settings', 'accounts', 'shortcuts', 'cli', 'about'] as const;

export type DialogTab = (typeof DIALOG_TABS)[number];

export const DIALOG_TAB_LABELS: Record<DialogTab, string> = {
  help: 'Help',
  settings: 'Settings',
  accounts: 'Accounts',
  shortcuts: 'Shortcuts',
  cli: 'CLI',
  about: 'About',
};

/** The tab `step` places away from `tab`, wrapping at either end. */
export function stepTab(tab: DialogTab, step: number): DialogTab {
  const n = DIALOG_TABS.length;
  const i = DIALOG_TABS.indexOf(tab);
  return DIALOG_TABS[(((i + step) % n) + n) % n];
}

/** The workspace action that opens each tab, keyed by action name. */
export const DIALOG_TAB_FOR_ACTION: Readonly<Record<string, DialogTab>> = {
  showHelp: 'help',
  openSettings: 'settings',
  showAccounts: 'accounts',
  showShortcuts: 'shortcuts',
  showCli: 'cli',
  showAbout: 'about',
};

/** Arrow keys scroll by this much; Page Up and Page Down by the visible height less this overlap. */
export const SCROLL_LINE_PX = 40;
export const SCROLL_PAGE_OVERLAP_PX = 40;

/** What a focused element does with the arrow and page keys itself, so the dialog must leave them. */
export interface KeyTargetInfo {
  tag: string;
  /** The `type` attribute of an input, lowercased. */
  type?: string;
  role?: string | null;
  editable?: boolean;
}

// Inputs that step a value with the arrows. A one-line text field only jumps its caret to an end,
// so it scrolls like everything else.
const STEPPING_INPUT_TYPES = new Set(['number', 'range', 'date', 'time', 'datetime-local', 'month', 'week']);
const OWN_KEYS_ROLES = new Set(['listbox', 'option', 'slider', 'spinbutton', 'combobox', 'menu', 'menuitem', 'radio', 'grid', 'tree', 'treeitem', 'textbox']);

/**
 * Pixels to scroll the open tab for a plain Up, Down, Page Up, or Page Down (docs/design/app.md
 * section 4.18), or 0 when the key is not one of those or the focused control uses it: text
 * areas, selects, number and range inputs, and lists move their own caret or value.
 */
export function dialogScrollDelta(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  target: KeyTargetInfo,
  viewportPx: number,
): number {
  if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return 0;
  const page = Math.max(SCROLL_LINE_PX, viewportPx - SCROLL_PAGE_OVERLAP_PX);
  const delta = { ArrowUp: -SCROLL_LINE_PX, ArrowDown: SCROLL_LINE_PX, PageUp: -page, PageDown: page }[e.key] ?? 0;
  if (delta === 0) return 0;
  const tag = target.tag.toLowerCase();
  if (target.editable || tag === 'textarea' || tag === 'select') return 0;
  if (tag === 'input' && STEPPING_INPUT_TYPES.has(target.type ?? 'text')) return 0;
  if (target.role && OWN_KEYS_ROLES.has(target.role)) return 0;
  return delta;
}
