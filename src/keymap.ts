import type { Direction } from './layout';

export type { Direction };

export type Action =
  | { type: 'splitRight' }
  | { type: 'splitDown' }
  | { type: 'splitAuto' }
  | { type: 'closePane' }
  | { type: 'moveFocus'; direction: Direction }
  | { type: 'resizePane'; direction: Direction }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'sendInput'; input: string }
  | { type: 'find' }
  | { type: 'toggleDashboard' }
  | { type: 'cycleScrim' }
  | { type: 'toggleBackdrop' }
  | { type: 'collapsePane' }
  | { type: 'togglePaneZoom' }
  | { type: 'openFavorite' }
  | { type: 'openLayout' }
  | { type: 'splitWithProfile' }
  | { type: 'showHelp' }
  | { type: 'openSettings' }
  | { type: 'toggleFullscreen' }
  | { type: 'newTab' }
  | { type: 'newScratch' }
  | { type: 'openFiles' }
  | { type: 'openGit' }
  | { type: 'openSearch' }
  | { type: 'closeTab' }
  | { type: 'nextTab' }
  | { type: 'prevTab' }
  | { type: 'switchToTab'; index: number }
  | { type: 'switchToLastTab' }
  | { type: 'increaseFontSize' }
  | { type: 'decreaseFontSize' }
  | { type: 'resetFontSize' };

/** Same shape the Rust settings loader sends (docs/design.md section 4.5). */
export interface KeybindingEntry {
  keys: string;
  action: string;
  direction?: Direction;
  input?: string;
  /** 1-based tab number for switchToTab. */
  index?: number;
}

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export type Keymap = Map<string, Action>;

const DIRECTIONS: readonly string[] = ['left', 'right', 'up', 'down'];
const SIMPLE_ACTIONS = [
  'splitRight',
  'splitDown',
  'splitAuto',
  'closePane',
  'copy',
  'paste',
  'find',
  'toggleDashboard',
  'cycleScrim',
  'toggleBackdrop',
  'collapsePane',
  'togglePaneZoom',
  'openFavorite',
  'openLayout',
  'splitWithProfile',
  'showHelp',
  'openSettings',
  'toggleFullscreen',
  'newTab',
  'newScratch',
  'openFiles',
  'openGit',
  'openSearch',
  'closeTab',
  'nextTab',
  'prevTab',
  'switchToLastTab',
  'increaseFontSize',
  'decreaseFontSize',
  'resetFontSize',
] as const;

const NAMED_KEYS = new Set([
  'left', 'right', 'up', 'down', 'enter', 'tab', 'escape', 'space', 'home', 'end',
  'pageup', 'pagedown', 'delete', 'backspace', 'insert',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

const EVENT_KEY_NAMES: Record<string, string> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  ' ': 'space',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Delete: 'delete',
  Backspace: 'backspace',
  Insert: 'insert',
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']);

const ALIASES: Record<string, string> = { win: 'meta', esc: 'escape', del: 'delete', ins: 'insert' };

export function parseChord(s: string): Chord | null {
  const text = s.trim().toLowerCase();
  if (!text) return null;
  // A trailing "+" is the plus key itself ("ctrl++"); a lone trailing "+" is an empty key and fails.
  const parts =
    text === '+'
      ? ['+']
      : text.endsWith('++')
        ? [...text.slice(0, -2).split('+'), '+']
        : text.split('+');
  const chord: Chord = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i].trim();
    const part = ALIASES[raw] ?? raw;
    const isLast = i === parts.length - 1;
    if (!isLast) {
      if (part !== 'ctrl' && part !== 'alt' && part !== 'shift' && part !== 'meta') return null;
      if (chord[part]) return null;
      chord[part] = true;
    } else {
      const isPlainKey = part.length === 1 && part !== ' ';
      if (!isPlainKey && !NAMED_KEYS.has(part)) return null;
      chord.key = part;
    }
  }
  return chord.key ? chord : null;
}

export function chordFromEvent(e: KeyboardEvent): Chord {
  let key: string;
  const code = e.code ?? '';
  // Digits come from code so shift+digit still reads as the digit. Other printable keys follow
  // the active layout (on Dvorak the comma sits on the physical W key), and letters fall back
  // to code only when the layout types something non-ASCII there, such as Cyrillic.
  if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^[!-~]$/.test(e.key)) key = e.key.toLowerCase();
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (MODIFIER_KEYS.has(e.key)) key = '';
  else if (EVENT_KEY_NAMES[e.key]) key = EVENT_KEY_NAMES[e.key];
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key.toLowerCase();
  else key = e.key.length === 1 ? e.key.toLowerCase() : '';
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key };
}

function chordId(c: Chord): string {
  return `${c.ctrl ? 'c' : ''}${c.alt ? 'a' : ''}${c.shift ? 's' : ''}${c.meta ? 'm' : ''}:${c.key}`;
}

function toAction(entry: KeybindingEntry): Action | string {
  const { action } = entry;
  if ((SIMPLE_ACTIONS as readonly string[]).includes(action)) {
    return { type: action } as Action;
  }
  if (action === 'moveFocus' || action === 'resizePane') {
    if (!entry.direction || !DIRECTIONS.includes(entry.direction)) {
      return `${action} needs a direction of left, right, up, or down`;
    }
    return { type: action, direction: entry.direction };
  }
  if (action === 'switchToTab') {
    const { index } = entry;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > 8) {
      return 'switchToTab needs an index from 1 to 8';
    }
    return { type: 'switchToTab', index };
  }
  if (action === 'sendInput') {
    if (typeof entry.input !== 'string' || entry.input === '') return 'sendInput needs a non-empty "input"';
    return { type: 'sendInput', input: entry.input };
  }
  // "unbound" is consumed by the Rust loader and never reaches here; it is treated as unknown.
  return `unknown action "${action}"`;
}

export function buildKeymap(entries: KeybindingEntry[]): { keymap: Keymap; warnings: string[] } {
  const keymap: Keymap = new Map();
  const warnings: string[] = [];
  entries.forEach((entry, i) => {
    const chord = parseChord(String(entry?.keys ?? ''));
    if (!chord) {
      warnings.push(`keybindings[${i}]: cannot parse keys "${entry?.keys}", skipped`);
      return;
    }
    const action = toAction(entry);
    if (typeof action === 'string') {
      warnings.push(`keybindings[${i}]: ${action}, skipped`);
      return;
    }
    keymap.set(chordId(chord), action);
  });
  return { keymap, warnings };
}

export function lookup(keymap: Keymap, e: KeyboardEvent): Action | null {
  const chord = chordFromEvent(e);
  if (!chord.key) return null;
  return keymap.get(chordId(chord)) ?? null;
}

/** Mirrors default_keybindings() in src-tauri/src/settings.rs. */
export const DEFAULT_KEYBINDINGS: KeybindingEntry[] = [
  { keys: 'ctrl+right', action: 'splitRight' },
  { keys: 'ctrl+down', action: 'splitDown' },
  { keys: 'alt+shift+d', action: 'splitAuto' },
  { keys: 'ctrl+w', action: 'closePane' },
  { keys: 'alt+left', action: 'moveFocus', direction: 'left' },
  { keys: 'alt+right', action: 'moveFocus', direction: 'right' },
  { keys: 'alt+up', action: 'moveFocus', direction: 'up' },
  { keys: 'alt+down', action: 'moveFocus', direction: 'down' },
  { keys: 'alt+shift+left', action: 'resizePane', direction: 'left' },
  { keys: 'alt+shift+right', action: 'resizePane', direction: 'right' },
  { keys: 'alt+shift+up', action: 'resizePane', direction: 'up' },
  { keys: 'alt+shift+down', action: 'resizePane', direction: 'down' },
  { keys: 'ctrl+shift+f', action: 'find' },
  { keys: 'ctrl+c', action: 'copy' },
  { keys: 'ctrl+shift+c', action: 'copy' },
  { keys: 'ctrl+v', action: 'paste' },
  { keys: 'ctrl+shift+v', action: 'paste' },
  { keys: 'shift+enter', action: 'sendInput', input: '\u001b\r' },
  { keys: 'ctrl+shift+s', action: 'toggleDashboard' },
  { keys: 'ctrl+shift+b', action: 'cycleScrim' },
  { keys: 'ctrl+shift+l', action: 'toggleBackdrop' },
  { keys: 'ctrl+shift+m', action: 'collapsePane' },
  { keys: 'ctrl+shift+z', action: 'togglePaneZoom' },
  { keys: 'ctrl+shift+o', action: 'openFavorite' },
  { keys: 'ctrl+shift+p', action: 'openLayout' },
  { keys: 'alt+shift+t', action: 'splitWithProfile' },
  { keys: 'ctrl+shift+t', action: 'newTab' },
  { keys: 'ctrl+shift+n', action: 'newScratch' },
  { keys: 'ctrl+shift+e', action: 'openFiles' },
  { keys: 'ctrl+shift+g', action: 'openGit' },
  { keys: 'ctrl+shift+h', action: 'openSearch' },
  { keys: 'ctrl+shift+w', action: 'closeTab' },
  { keys: 'ctrl+tab', action: 'nextTab' },
  { keys: 'ctrl+shift+tab', action: 'prevTab' },
  { keys: 'f1', action: 'showHelp' },
  { keys: 'ctrl+,', action: 'openSettings' },
  { keys: 'f11', action: 'toggleFullscreen' },
  ...Array.from({ length: 8 }, (_, i) => ({ keys: `ctrl+alt+${i + 1}`, action: 'switchToTab', index: i + 1 })),
  { keys: 'ctrl+alt+9', action: 'switchToLastTab' },
  { keys: 'ctrl+=', action: 'increaseFontSize' },
  { keys: 'ctrl++', action: 'increaseFontSize' },
  { keys: 'ctrl+-', action: 'decreaseFontSize' },
  { keys: 'ctrl+0', action: 'resetFontSize' },
];
