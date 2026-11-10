import { ACTION_REGISTRY, HELP_SECTION_TITLES, actionArg, type ActionRow } from './actionRegistry';
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

export const HELP_SECTIONS: { title: string; actions: string[] }[] = HELP_SECTION_TITLES.map((title) => ({
  title,
  actions: ACTION_REGISTRY.filter((r) => r.section === title).map((r) => r.name),
}));

export const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  ACTION_REGISTRY.flatMap((r: ActionRow) => (r.label === undefined ? [] : [[r.name, r.label]])),
);

/** The F1 label for an action; directional actions append the direction. */
export function actionLabel(action: string, direction?: Direction): string | undefined {
  const base = ACTION_LABELS[action];
  if (base !== undefined && direction && actionArg(action) === 'direction') return `${base} ${direction}`;
  return base;
}

/** Every action name in F1 guide order. */
export function actionOrder(): string[] {
  return HELP_SECTIONS.flatMap((s) => s.actions);
}

export const ACTION_NOTES: Record<string, string> = Object.fromEntries(
  ACTION_REGISTRY.flatMap((r: ActionRow) => (r.note === undefined ? [] : [[r.name, r.note]])),
);

/** Keys handled inside overlays, which are not part of the keymap. */
export const FIXED_SECTION: HelpSection = {
  title: 'In pickers and bars',
  rows: [
    { label: 'Open favorite as a split', keys: ['Enter'] },
    { label: 'Open favorite or worktree collapsed', keys: ['Ctrl+Enter'], note: 'Ctrl+click works on dashboard rows too' },
    { label: 'Rename the selected favorite or layout', keys: ['F2'] },
    { label: 'Remove the selected favorite or layout', keys: ['Delete'], note: 'Layouts ask first' },
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
