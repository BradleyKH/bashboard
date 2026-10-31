import { type Chord, type Direction } from './keymap';

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

export const HELP_SECTIONS: { title: string; actions: string[] }[] = [
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
  { title: 'Workspace', actions: ['openPalette', 'nextAttention', 'toggleDashboard', 'focusDashboard', 'openFavorite', 'openLayout', 'splitWithProfile', 'cycleScrim', 'toggleBackdrop', 'toggleFullscreen', 'showHelp', 'openSettings'] },
];

export const ACTION_LABELS: Record<string, string> = {
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
  focusDashboard: 'Move focus to the dashboard and back',
  openFavorite: 'Open a favorite folder',
  openLayout: 'Open a saved layout',
  openPalette: 'Command palette',
  nextAttention: 'Jump to the next terminal that needs you',
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

/** The F1 label for an action; directional actions append the direction. */
export function actionLabel(action: string, direction?: Direction): string | undefined {
  const base = ACTION_LABELS[action];
  if (base !== undefined && direction && (action === 'moveFocus' || action === 'resizePane')) return `${base} ${direction}`;
  return base;
}

/** Every action name in F1 guide order. */
export function actionOrder(): string[] {
  return HELP_SECTIONS.flatMap((s) => s.actions);
}

export const ACTION_NOTES: Record<string, string> = {
  copy: 'With nothing selected, the key goes to the shell',
  paste: 'With no text on the clipboard, the key goes to the shell so Claude Code can paste an image',
};

/** Keys handled inside overlays, which are not part of the keymap. */
export const FIXED_SECTION: HelpSection = {
  title: 'In pickers and bars',
  rows: [
    { label: 'Open favorite as a split', keys: ['Enter'] },
    { label: 'Open favorite or worktree collapsed', keys: ['Ctrl+Enter'], note: 'Ctrl+click works on dashboard rows too' },
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

export function formatModifiers(c: Chord): string {
  return (c.ctrl ? 'Ctrl+' : '') + (c.alt ? 'Alt+' : '') + (c.shift ? 'Shift+' : '') + (c.meta ? 'Win+' : '');
}

export function formatChord(c: Chord): string {
  const key = KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1));
  return formatModifiers(c) + key;
}

export function sendInputLabel(input: string): string {
  if (input === CLAUDE_NEWLINE) return 'Claude Code newline';
  return `Type ${JSON.stringify(input)}`;
}
