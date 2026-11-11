import { ACTION_REGISTRY, HELP_SECTION_TITLES, actionArg, type ActionRow } from './actionRegistry';
import { type Chord, type Direction } from './keymap';
import { platformOs, type Os } from './platform';

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
export function fixedSection(os: Os = platformOs()): HelpSection {
  const mod = os === 'macos' ? 'Cmd' : 'Ctrl';
  return {
    title: 'In pickers and bars',
    rows: [
      { label: 'Open favorite as a split', keys: ['Enter'] },
      { label: 'Open favorite or worktree collapsed', keys: [`${mod}+Enter`], note: `${mod}+click works on dashboard rows too` },
      { label: 'Rename the selected favorite or layout', keys: ['F2'] },
      { label: 'Remove the selected favorite or layout', keys: ['Delete'], note: 'Layouts ask first' },
      { label: 'Next / previous match', keys: ['Enter', 'Shift+Enter'] },
      { label: 'Close', keys: ['Escape'] },
    ],
  };
}

const KEY_NAMES: Record<string, string> = {
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  backspace: 'Backspace',
};

/** Modifier names in the OS's own words and order: "Cmd+Option+" on macOS, "Ctrl+Alt+" elsewhere. */
export function formatModifiers(c: Omit<Chord, 'key'>, os: Os = platformOs()): string {
  if (os === 'macos') {
    return (c.meta ? 'Cmd+' : '') + (c.ctrl ? 'Ctrl+' : '') + (c.alt ? 'Option+' : '') + (c.shift ? 'Shift+' : '');
  }
  return (c.ctrl ? 'Ctrl+' : '') + (c.alt ? 'Alt+' : '') + (c.shift ? 'Shift+' : '') + (c.meta ? 'Win+' : '');
}

export function formatChord(c: Chord, os: Os = platformOs()): string {
  const key = KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1));
  return formatModifiers(c, os) + key;
}

export function sendInputLabel(input: string): string {
  if (input === CLAUDE_NEWLINE) return 'Claude Code newline';
  return `Type ${JSON.stringify(input)}`;
}
