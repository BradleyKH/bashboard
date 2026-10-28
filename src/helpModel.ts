import { parseChord, type Chord, type KeybindingEntry } from './keymap';

export interface HelpRow {
  label: string;
  keys: string[];
  note?: string;
}

export interface HelpSection {
  title: string;
  rows: HelpRow[];
}

const CLAUDE_NEWLINE = '\u001b\r';
const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;

const SECTIONS: { title: string; actions: string[] }[] = [
  {
    title: 'Panes',
    actions: ['splitRight', 'splitDown', 'splitAuto', 'closePane', 'newScratch', 'openFiles', 'openGit', 'openSearch', 'collapsePane', 'togglePaneZoom', 'moveFocus', 'resizePane'],
  },
  {
    title: 'Tabs',
    actions: ['newTab', 'closeTab', 'nextTab', 'prevTab', 'switchToTab', 'switchToLastTab'],
  },
  {
    title: 'Terminal',
    actions: ['copy', 'paste', 'find', 'sendInput', 'increaseFontSize', 'decreaseFontSize', 'resetFontSize'],
  },
  { title: 'Workspace', actions: ['toggleDashboard', 'openFavorite', 'openLayout', 'splitWithProfile', 'cycleScrim', 'toggleBackdrop', 'toggleFullscreen', 'showHelp', 'openSettings'] },
];

const LABELS: Record<string, string> = {
  splitRight: 'Split right',
  splitDown: 'Split down',
  splitAuto: 'Split along the longer side',
  closePane: 'Close pane',
  newScratch: 'New scratch pad',
  openFiles: 'Open files for the repo',
  openGit: 'Git pane for this repo',
  openSearch: 'Search the repo\'s code',
  collapsePane: 'Collapse pane',
  togglePaneZoom: 'Zoom or unzoom pane',
  moveFocus: 'Move focus',
  resizePane: 'Resize pane',
  copy: 'Copy selection',
  paste: 'Paste',
  find: 'Find in scrollback or file preview',
  toggleDashboard: 'Toggle dashboard',
  openFavorite: 'Open a favorite folder',
  openLayout: 'Open a saved layout',
  splitWithProfile: 'Split with a chosen shell',
  cycleScrim: 'Cycle backdrop dimming',
  toggleBackdrop: 'Pause or resume the background animation',
  showHelp: 'Keyboard shortcuts',
  openSettings: 'Settings',
  toggleFullscreen: 'Toggle full screen',
  newTab: 'New tab',
  closeTab: 'Close tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  switchToTab: 'Go to tab 1 to 8',
  switchToLastTab: 'Go to the last tab',
  increaseFontSize: 'Increase font size',
  decreaseFontSize: 'Decrease font size',
  resetFontSize: 'Reset font size',
};

const NOTES: Record<string, string> = {
  copy: 'With nothing selected, the key goes to the shell',
  paste: 'With no text on the clipboard, the key goes to the shell so Claude Code can paste an image',
};

/** Keys handled inside overlays, which are not part of the keymap. */
const FIXED_SECTION: HelpSection = {
  title: 'In pickers and bars',
  rows: [
    { label: 'Open favorite as a split', keys: ['Enter'] },
    { label: 'Open favorite collapsed', keys: ['Ctrl+Enter'], note: 'Ctrl+click works on dashboard rows too' },
    { label: 'Next / previous match', keys: ['Enter', 'Shift+Enter'] },
    { label: 'Close', keys: ['Escape'] },
  ],
};

const KEY_NAMES: Record<string, string> = {
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  backspace: 'Backspace',
};

function modifiers(c: Chord): string {
  return (c.ctrl ? 'Ctrl+' : '') + (c.alt ? 'Alt+' : '') + (c.shift ? 'Shift+' : '') + (c.meta ? 'Win+' : '');
}

export function formatChord(c: Chord): string {
  const key = KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1));
  return modifiers(c) + key;
}

function sendInputLabel(input: string): string {
  if (input === CLAUDE_NEWLINE) return 'New line in Claude Code';
  return `Type ${JSON.stringify(input)}`;
}

/**
 * Directional bindings collapse to one "Alt+Arrows" entry when all four arrows share the same
 * modifiers; otherwise each binding is listed with its direction.
 */
function directionalKeys(bindings: { chord: Chord; direction?: string }[]): string[] {
  const arrows = DIRECTIONS.map((d) => bindings.filter((b) => b.direction === d && b.chord.key === d));
  if (arrows.every((a) => a.length === 1)) {
    const mods = arrows.map((a) => modifiers(a[0].chord));
    if (mods.every((m) => m === mods[0])) {
      const rest = bindings.filter((b) => b.chord.key !== b.direction);
      return [`${mods[0]}Arrows`, ...rest.map((b) => `${formatChord(b.chord)} (${b.direction})`)];
    }
  }
  return bindings.map((b) => `${formatChord(b.chord)} (${b.direction})`);
}

/** Number-key bindings collapse to one "Ctrl+Alt+1-8" entry when they share modifiers. */
function tabNumberKeys(bindings: { chord: Chord; index?: number }[]): string[] {
  const mods = modifiers(bindings[0].chord);
  const digits = bindings.map((b) => b.chord.key);
  const collapsible =
    bindings.every((b) => modifiers(b.chord) === mods && b.chord.key === String(b.index)) &&
    digits.length > 1;
  if (!collapsible) return bindings.map((b) => `${formatChord(b.chord)} (tab ${b.index})`);
  const nums = bindings.map((b) => b.index as number).sort((a, b) => a - b);
  return [`${mods}${nums[0]}-${nums[nums.length - 1]}`];
}

/** The help guide's contents, built from the live keybindings so overrides show. */
export function helpSections(entries: KeybindingEntry[]): HelpSection[] {
  const valid = entries.flatMap((e) => {
    const chord = parseChord(String(e?.keys ?? ''));
    return chord ? [{ entry: e, chord }] : [];
  });
  const sections = SECTIONS.map(({ title, actions }) => {
    const rows: HelpRow[] = [];
    for (const action of actions) {
      const bound = valid.filter((v) => v.entry.action === action);
      if (bound.length === 0) continue;
      if (action === 'sendInput') {
        for (const { entry, chord } of bound) {
          if (typeof entry.input !== 'string' || entry.input === '') continue;
          rows.push({ label: sendInputLabel(entry.input), keys: [formatChord(chord)] });
        }
        continue;
      }
      const keys =
        action === 'switchToTab'
          ? tabNumberKeys(bound.map((v) => ({ chord: v.chord, index: v.entry.index })))
          : action === 'moveFocus' || action === 'resizePane'
          ? directionalKeys(bound.map((v) => ({ chord: v.chord, direction: v.entry.direction })))
          : bound.map((v) => formatChord(v.chord));
      rows.push({ label: LABELS[action], keys, note: NOTES[action] });
    }
    return { title, rows };
  });
  return [...sections.filter((s) => s.rows.length > 0), FIXED_SECTION];
}
