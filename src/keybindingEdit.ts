import {
  DEFAULT_KEYBINDINGS,
  actionFromEntry,
  chordId,
  chordKeys,
  parseChord,
  type Chord,
  type Direction,
  type KeybindingEntry,
} from './keymap';
import { ACTION_LABELS, ACTION_NOTES, HELP_SECTIONS, formatChord, sendInputLabel } from './helpModel';
import type { KeybindingOp } from './settings';

export interface EditArgs {
  direction?: Direction;
  index?: number;
  input?: string;
}

export interface EditRow {
  id: string;
  section: string;
  label: string;
  action: string;
  args: EditArgs;
  /** Live keys strings in the user's own spelling, in payload order. */
  chords: string[];
  defaults: string[];
  modified: boolean;
  note?: string;
  shellNotes: string[];
}

export interface EditSection {
  title: string;
  rows: EditRow[];
}

export type ChordCheck =
  | { kind: 'refused'; message: string }
  | { kind: 'same' }
  | { kind: 'free'; shellNote?: string }
  | { kind: 'conflict'; owner: EditRow; leavesEmpty: boolean };

const DIRECTIONS: readonly Direction[] = ['left', 'right', 'up', 'down'];

/** Keys bash or Claude Code use; `use` completes "Ctrl+R no longer reaches ...". */
export const SHELL_KEYS: readonly { keys: string; use: string }[] = [
  { keys: 'ctrl+a', use: "bash's start of line" },
  { keys: 'ctrl+e', use: "bash's end of line" },
  { keys: 'ctrl+k', use: "bash's cut to end of line" },
  { keys: 'ctrl+u', use: "bash's cut to start of line" },
  { keys: 'ctrl+w', use: "bash's delete previous word" },
  { keys: 'ctrl+r', use: "bash's reverse search" },
  { keys: 'ctrl+l', use: "bash's clear screen" },
  { keys: 'ctrl+d', use: "bash's end of input" },
  { keys: 'ctrl+c', use: "the shell's interrupt" },
  { keys: 'ctrl+z', use: "the shell's suspend" },
  { keys: 'ctrl+y', use: "bash's paste of cut text" },
  { keys: 'ctrl+p', use: "bash's previous command" },
  { keys: 'ctrl+n', use: "bash's next command" },
  { keys: 'ctrl+left', use: "bash's word back" },
  { keys: 'ctrl+right', use: "bash's word forward" },
  { keys: 'alt+b', use: "bash's word back" },
  { keys: 'alt+f', use: "bash's word forward" },
  { keys: 'alt+.', use: "bash's last argument" },
  { keys: 'shift+tab', use: "Claude Code's mode switch" },
];

const SHELL_USES = new Map(SHELL_KEYS.map((s) => [chordId(parseChord(s.keys)!), s.use]));

/** The dimmed note for a shell key, or undefined when the chord is not on the list. */
export function shellNoteFor(keys: string): string | undefined {
  const chord = parseChord(keys);
  const use = chord && SHELL_USES.get(chordId(chord));
  return use ? `${formatChord(chord)} no longer reaches ${use}` : undefined;
}

function argsOf(entry: KeybindingEntry): EditArgs {
  if (entry.action === 'moveFocus' || entry.action === 'resizePane') return { direction: entry.direction };
  if (entry.action === 'switchToTab') return { index: entry.index };
  if (entry.action === 'sendInput') return { input: entry.input };
  return {};
}

function rowId(action: string, args: EditArgs): string {
  if (args.direction !== undefined) return `${action}:${args.direction}`;
  if (args.index !== undefined) return `${action}:${args.index}`;
  if (args.input !== undefined) return `${action}:${JSON.stringify(args.input)}`;
  return action;
}

interface Bound {
  entry: KeybindingEntry;
  chord: Chord;
  row: string;
}

/** Valid entries by chord id; a later entry wins, as in buildKeymap. */
function boundByChord(entries: KeybindingEntry[]): Map<string, Bound> {
  const map = new Map<string, Bound>();
  for (const entry of entries) {
    const chord = parseChord(String(entry?.keys ?? ''));
    if (!chord || !actionFromEntry(entry)) continue;
    const id = chordId(chord);
    map.delete(id);
    map.set(id, { entry, chord, row: rowId(entry.action, argsOf(entry)) });
  }
  return map;
}

const DEFAULTS = boundByChord(DEFAULT_KEYBINDINGS);

function rowLabel(action: string, args: EditArgs): string {
  if (args.direction) return `${ACTION_LABELS[action]} ${args.direction}`;
  if (args.index !== undefined) return `Go to tab ${args.index}`;
  if (args.input !== undefined) return sendInputLabel(args.input);
  return ACTION_LABELS[action];
}

function rowArgs(action: string, live: Map<string, Bound>): EditArgs[] {
  if (action === 'moveFocus' || action === 'resizePane') return DIRECTIONS.map((direction) => ({ direction }));
  if (action === 'switchToTab') return Array.from({ length: 8 }, (_, i) => ({ index: i + 1 }));
  if (action === 'sendInput') {
    const inputs: string[] = [];
    for (const b of [...DEFAULTS.values(), ...live.values()]) {
      if (b.entry.action === 'sendInput' && !inputs.includes(b.entry.input!)) inputs.push(b.entry.input!);
    }
    return inputs.map((input) => ({ input }));
  }
  return [{}];
}

function sameSet(a: string[], b: string[]): boolean {
  const ids = (keys: string[]) => new Set(keys.map((k) => chordId(parseChord(k)!)));
  const x = ids(a);
  const y = ids(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
}

/** Every editable row, in the F1 guide's section order, built from the live merged keybindings. */
export function editSections(live: KeybindingEntry[]): EditSection[] {
  const bound = boundByChord(live);
  return HELP_SECTIONS.map(({ title, actions }) => ({
    title,
    rows: actions.flatMap((action) =>
      rowArgs(action, bound).map((args): EditRow => {
        const id = rowId(action, args);
        const chords = [...bound.values()].filter((b) => b.row === id).map((b) => b.entry.keys);
        const defaults = [...DEFAULTS.values()].filter((b) => b.row === id).map((b) => b.entry.keys);
        const shellNotes = chords.flatMap((keys) => {
          if (DEFAULTS.get(chordId(parseChord(keys)!))?.row === id) return [];
          const note = shellNoteFor(keys);
          return note ? [note] : [];
        });
        const row: EditRow = {
          id,
          section: title,
          label: rowLabel(action, args),
          action,
          args,
          chords,
          defaults,
          modified: !sameSet(chords, defaults),
          shellNotes,
        };
        if (ACTION_NOTES[action]) row.note = ACTION_NOTES[action];
        return row;
      }),
    ),
  }));
}

/** Rows whose label contains the query, ignoring case; sections left empty are dropped. */
export function filterSections(sections: EditSection[], query: string): EditSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections
    .map((s) => ({ ...s, rows: s.rows.filter((r) => r.label.toLowerCase().includes(q)) }))
    .filter((s) => s.rows.length > 0);
}

/** The row whose action the chord runs, or null when the chord reaches the shell. */
export function ownerOf(chord: Chord, live: KeybindingEntry[]): EditRow | null {
  const id = chordId(chord);
  for (const section of editSections(live)) {
    for (const row of section.rows) {
      if (row.chords.some((k) => chordId(parseChord(k)!) === id)) return row;
    }
  }
  return null;
}

function refusal(chord: Chord): string | undefined {
  if (chord.ctrl || chord.alt || chord.meta) return undefined;
  const name = formatChord(chord);
  if (chord.key === 'space') return `${name} would stop typing a space`;
  if (chord.key.length === 1) {
    if (/^[a-z]$/.test(chord.key)) return `${name} would stop typing ${chord.shift ? chord.key.toUpperCase() : chord.key}`;
    return `${name} would stop typing ${chord.shift ? 'a character' : chord.key}`;
  }
  if (!chord.shift && ['escape', 'enter', 'tab', 'backspace'].includes(chord.key)) {
    return `${name} would stop reaching the shell`;
  }
  return undefined;
}

/** What recording `chord` on `row` would do, before anything is saved (docs/v0.2.0-design.md section 8.2). */
export function checkChord(chord: Chord, row: EditRow, live: KeybindingEntry[]): ChordCheck {
  const message = refusal(chord);
  if (message) return { kind: 'refused', message };
  const id = chordId(chord);
  if (row.chords.some((k) => chordId(parseChord(k)!) === id)) return { kind: 'same' };
  const owner = ownerOf(chord, live);
  if (owner) return { kind: 'conflict', owner, leavesEmpty: owner.chords.length === 1 };
  if (DEFAULTS.get(id)?.row === row.id) return { kind: 'free' };
  const shellNote = shellNoteFor(chordKeys(chord));
  return shellNote ? { kind: 'free', shellNote } : { kind: 'free' };
}

function bindOp(keys: string, action: string, args: EditArgs): KeybindingOp {
  const op: KeybindingOp = { op: 'bind', keys, action };
  if (args.direction !== undefined) op.direction = args.direction;
  if (args.index !== undefined) op.index = args.index;
  if (args.input !== undefined) op.input = args.input;
  return op;
}

/** Adds a chord to the row; when another row holds it, the same bind moves it. */
export function addOps(row: EditRow, chord: Chord): KeybindingOp[] {
  return [bindOp(chordKeys(chord), row.action, row.args)];
}

export function replaceOps(row: EditRow, oldKeys: string, chord: Chord): KeybindingOp[] {
  return [{ op: 'unbind', keys: oldKeys }, bindOp(chordKeys(chord), row.action, row.args)];
}

export function removeOps(oldKeys: string): KeybindingOp[] {
  return [{ op: 'unbind', keys: oldKeys }];
}

/**
 * Resets every chord in the row's live and default sets whose live action differs from its
 * default. `takes` are the row's default chords another row holds, which the dialog confirms first.
 */
export function resetPlan(row: EditRow, live: KeybindingEntry[]): { ops: KeybindingOp[]; takes: { keys: string; owner: EditRow }[] } {
  const bound = boundByChord(live);
  const ops: KeybindingOp[] = [];
  const takes: { keys: string; owner: EditRow }[] = [];
  const seen = new Set<string>();
  for (const keys of [...row.chords, ...row.defaults]) {
    const id = chordId(parseChord(keys)!);
    if (seen.has(id)) continue;
    seen.add(id);
    const now = bound.get(id);
    const def = DEFAULTS.get(id);
    if (now?.row === def?.row) continue;
    const liveKeys = now?.entry.keys ?? keys;
    ops.push({ op: 'reset', keys: liveKeys });
    if (def?.row === row.id && now) {
      const owner = ownerOf(now.chord, live);
      if (owner) takes.push({ keys: liveKeys, owner });
    }
  }
  return { ops, takes };
}

export function resetAllOps(): KeybindingOp[] {
  return [{ op: 'resetAll' }];
}

/** The ops that put every chord `ops` touch back to its state in `live`; Undo sends these. */
export function inverseOps(ops: KeybindingOp[], live: KeybindingEntry[]): KeybindingOp[] {
  const bound = boundByChord(live);
  const touched = new Map<string, string>();
  for (const op of ops) {
    if (op.op === 'resetAll') {
      for (const [id, b] of [...DEFAULTS, ...bound]) {
        if (bound.get(id)?.row !== DEFAULTS.get(id)?.row) touched.set(id, b.entry.keys);
      }
      continue;
    }
    const chord = parseChord(op.keys);
    if (chord && !touched.has(chordId(chord))) touched.set(chordId(chord), op.keys);
  }
  return [...touched].map(([id, opKeys]): KeybindingOp => {
    const now = bound.get(id);
    const def = DEFAULTS.get(id);
    const keys = now?.entry.keys ?? def?.entry.keys ?? opKeys;
    if (now?.row === def?.row) return { op: 'reset', keys };
    if (now) return bindOp(keys, now.entry.action, argsOf(now.entry));
    return def ? { op: 'unbind', keys } : { op: 'reset', keys };
  });
}

/** The merged keybindings after `ops`, modeling settings_keybindings_edit plus the loader's merge. */
export function applyOps(live: KeybindingEntry[], ops: KeybindingOp[]): KeybindingEntry[] {
  let entries = [...live];
  for (const op of ops) {
    if (op.op === 'resetAll') {
      entries = [...DEFAULT_KEYBINDINGS];
      continue;
    }
    const chord = parseChord(op.keys);
    if (!chord) continue;
    const id = chordId(chord);
    entries = entries.filter((e) => {
      const c = parseChord(String(e?.keys ?? ''));
      return !c || chordId(c) !== id;
    });
    if (op.op === 'bind') {
      entries.push({ keys: op.keys, action: op.action, ...argsOf(op) });
    } else if (op.op === 'reset') {
      const def = DEFAULTS.get(id);
      if (def) entries.push(def.entry);
    }
  }
  return entries;
}

function quoteKeys(keys: string): string {
  const chord = parseChord(keys);
  return chord ? formatChord(chord) : keys;
}

export function moveStripText(keys: string, owner: EditRow, leavesEmpty: boolean): string {
  return `${quoteKeys(keys)} runs "${owner.label}". Move it here?${leavesEmpty ? ' It will have no key.' : ''}`;
}

export function resetStripText(takes: { keys: string; owner: EditRow }[]): string {
  const runs = takes.map((t) => `${quoteKeys(t.keys)} runs ${t.owner.label}.`).join(' ');
  return `${runs} ${takes.length > 1 ? 'Move them back?' : 'Move it back?'}`;
}

export function movedNoticeText(keys: string, owner: EditRow): string {
  return `${quoteKeys(keys)} moved from ${owner.label}`;
}
