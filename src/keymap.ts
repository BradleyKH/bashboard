import { ACTION_REGISTRY, actionArg, type ActionName } from './actionRegistry';
import defaultKeybindings from './defaultKeybindings.json';
import type { Direction } from './layout';

export type { Direction };

export type Action =
  | { type: 'splitRight' }
  | { type: 'splitDown' }
  | { type: 'splitLeft' }
  | { type: 'splitUp' }
  | { type: 'splitAuto' }
  | { type: 'closePane' }
  | { type: 'moveFocus'; direction: Direction }
  | { type: 'resizePane'; direction: Direction }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'sendInput'; input: string }
  | { type: 'find' }
  | { type: 'toggleDashboard' }
  | { type: 'focusDashboard' }
  | { type: 'cycleScrim' }
  | { type: 'toggleBackdrop' }
  | { type: 'collapsePane' }
  | { type: 'togglePaneZoom' }
  | { type: 'openFavorite' }
  | { type: 'openLayout' }
  | { type: 'openLaunch' }
  | { type: 'openPalette' }
  | { type: 'nextAttention' }
  | { type: 'splitWithProfile' }
  | { type: 'showHelp' }
  | { type: 'openSettings' }
  | { type: 'showShortcuts' }
  | { type: 'showAccounts' }
  | { type: 'showCli' }
  | { type: 'showAbout' }
  | { type: 'toggleFullscreen' }
  | { type: 'newTab' }
  | { type: 'newScratch' }
  | { type: 'openFiles' }
  | { type: 'openGit' }
  | { type: 'openSearch' }
  | { type: 'openEditor' }
  | { type: 'closeTab' }
  | { type: 'nextTab' }
  | { type: 'prevTab' }
  | { type: 'switchToTab'; index: number }
  | { type: 'switchToLastTab' }
  | { type: 'increaseFontSize' }
  | { type: 'decreaseFontSize' }
  | { type: 'resetFontSize' };

/** Same shape the Rust settings loader sends (docs/design/keys.md section 4.5). */
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
export const SIMPLE_ACTIONS: readonly ActionName[] = ACTION_REGISTRY.filter((r) => r.arg === 'none').map((r) => r.name);
export const ARG_ACTIONS: readonly ActionName[] = ACTION_REGISTRY.filter((r) => r.arg !== 'none').map((r) => r.name);

/** Every action name toAction accepts. */
export const ACTION_NAMES: readonly string[] = [...SIMPLE_ACTIONS, ...ARG_ACTIONS];

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

/** The canonical settings spelling of a chord, in the style of DEFAULT_KEYBINDINGS ("ctrl++" is the plus key). */
export function chordKeys(c: Chord): string {
  const mods = [c.ctrl && 'ctrl', c.alt && 'alt', c.shift && 'shift', c.meta && 'win'].filter(Boolean) as string[];
  return [...mods, c.key].join('+');
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

export function chordId(c: Chord): string {
  return `${c.ctrl ? 'c' : ''}${c.alt ? 'a' : ''}${c.shift ? 's' : ''}${c.meta ? 'm' : ''}:${c.key}`;
}

function toAction(entry: KeybindingEntry): Action | string {
  const { action } = entry;
  switch (actionArg(action)) {
    case 'none':
      return { type: action } as Action;
    case 'direction':
      if (!entry.direction || !DIRECTIONS.includes(entry.direction)) {
        return `${action} needs a direction of left, right, up, or down`;
      }
      return { type: action, direction: entry.direction } as Action;
    case 'index': {
      const { index } = entry;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > 8) {
        return `${action} needs an index from 1 to 8`;
      }
      return { type: action, index } as Action;
    }
    case 'input':
      if (typeof entry.input !== 'string' || entry.input === '') return `${action} needs a non-empty "input"`;
      return { type: action, input: entry.input } as Action;
    case undefined:
      // "unbound" is consumed by the Rust loader and never reaches here; it is treated as unknown.
      return `unknown action "${action}"`;
  }
}

/** The action a keybinding entry would run, or null when the entry is invalid. */
export function actionFromEntry(entry: KeybindingEntry): Action | null {
  const action = toAction(entry);
  return typeof action === 'string' ? null : action;
}

/** The keymap, a warning per skipped entry, and the `keys` of every entry that made it in. */
export function buildKeymap(entries: KeybindingEntry[]): { keymap: Keymap; warnings: string[]; keys: string[] } {
  const keymap: Keymap = new Map();
  const warnings: string[] = [];
  const keys: string[] = [];
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
    keys.push(String(entry.keys));
  });
  return { keymap, warnings, keys };
}

export function lookup(keymap: Keymap, e: KeyboardEvent): Action | null {
  const chord = chordFromEvent(e);
  if (!chord.key) return null;
  return keymap.get(chordId(chord)) ?? null;
}

/** The built-in defaults; default_keybindings() in src-tauri/src/settings/keybindings.rs reads the same file. */
export const DEFAULT_KEYBINDINGS: KeybindingEntry[] = defaultKeybindings as KeybindingEntry[];
