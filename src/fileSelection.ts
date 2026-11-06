/**
 * Files list multi-selection rules, as File Explorer has them (docs/design/files.md section 4.12).
 */

export interface FileSelection {
  /** The focused row, which the preview follows; it can be unmarked after a Ctrl+click. */
  cursor: string | null;
  /** Where a Shift range starts. */
  anchor: string | null;
  /** The selected names, in list order. */
  marked: readonly string[];
}

export const EMPTY_SELECTION: FileSelection = { cursor: null, anchor: null, marked: [] };

export interface SelectMods {
  shift?: boolean;
  ctrl?: boolean;
}

/** One selected name, or nothing for null. */
export function single(name: string | null): FileSelection {
  return name === null ? EMPTY_SELECTION : { cursor: name, anchor: name, marked: [name] };
}

function inOrder(names: readonly string[], keep: ReadonlySet<string>): string[] {
  return names.filter((n) => keep.has(n));
}

function range(names: readonly string[], from: string, to: string): string[] {
  const a = names.indexOf(from);
  const b = names.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return names.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * A click (or Shift+arrow) on `name`, with `names` the visible entries in order. Plain selects
 * just it; Ctrl toggles it; Shift selects from the anchor to it, and Ctrl+Shift adds that range.
 */
export function selectAt(sel: FileSelection, name: string, mods: SelectMods, names: readonly string[]): FileSelection {
  if (mods.shift) {
    const anchor = sel.anchor !== null && names.includes(sel.anchor) ? sel.anchor : (sel.cursor ?? name);
    const span = range(names, anchor, name);
    const marked = mods.ctrl ? inOrder(names, new Set([...sel.marked, ...span])) : span;
    return { cursor: name, anchor, marked };
  }
  if (mods.ctrl) {
    const set = new Set(sel.marked);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    return { cursor: name, anchor: name, marked: inOrder(names, set) };
  }
  return single(name);
}

export function selectAll(sel: FileSelection, names: readonly string[]): FileSelection {
  if (names.length === 0) return sel;
  return { cursor: sel.cursor ?? names[0], anchor: sel.anchor ?? names[0], marked: [...names] };
}

/** Drops names no longer listed (a refresh or a filter); a vanished cursor or anchor clears. */
export function pruneSelection(sel: FileSelection, names: readonly string[]): FileSelection {
  const set = new Set(names);
  const marked = sel.marked.filter((n) => set.has(n));
  const cursor = sel.cursor !== null && set.has(sel.cursor) ? sel.cursor : null;
  const anchor = sel.anchor !== null && set.has(sel.anchor) ? sel.anchor : cursor;
  if (marked.length === sel.marked.length && cursor === sel.cursor && anchor === sel.anchor) return sel;
  return { cursor, anchor, marked };
}

export function isMarked(sel: FileSelection, name: string): boolean {
  return sel.marked.includes(name);
}
