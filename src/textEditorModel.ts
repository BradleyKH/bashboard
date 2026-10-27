/** Text editor save and reload rules (docs/design.md section 4.12, Text editor). */

/** Typing that stops for this long triggers a save. */
export const EDITOR_SAVE_DELAY_MS = 1000;

export interface EditorState {
  text: string;
  /** What is on disk as far as the editor knows. */
  savedText: string;
  /** The file's modified time at the last read or save. */
  modified: number;
  /** A save is in flight. */
  saving: boolean;
  /** The Reload or Keep mine bar is showing; saves are held until it is answered. */
  conflict: boolean;
  /** Text the in-flight save carries. */
  savingText: string | null;
  /** A read for a disk change is in flight; saves wait for it. */
  reloading: boolean;
}

export type EditorEvent =
  | { type: 'edit'; text: string }
  /** Debounce fired, blur, or Ctrl+S. */
  | { type: 'saveRequested' }
  | { type: 'saved'; modified: number }
  | { type: 'saveFailed'; conflict: boolean }
  /** The folder watch saw the file's modified time change. */
  | { type: 'diskChanged'; modified: number }
  /** A fresh read finished: a disk change check, or the Reload button. */
  | { type: 'reloaded'; text: string; modified: number }
  /** The read for a disk change failed. */
  | { type: 'reloadFailed' }
  /** Keep mine, with the file's current modified time from a fresh read. */
  | { type: 'keepMine'; modified: number };

export type EditorEffect =
  | { type: 'schedule'; ms: number }
  | { type: 'cancel' }
  | { type: 'save'; text: string; expectedModified: number }
  /** Read the file and answer with `reloaded`. */
  | { type: 'reload' }
  | { type: 'setText'; text: string };

export interface EditorStep {
  state: EditorState;
  effects: EditorEffect[];
}

export function initialEditorState(text: string, modified: number): EditorState {
  return { text, savedText: text, modified, saving: false, conflict: false, savingText: null, reloading: false };
}

export function isDirty(s: EditorState): boolean {
  return s.text !== s.savedText;
}

function startSave(s: EditorState): EditorStep {
  return {
    state: { ...s, saving: true, savingText: s.text },
    effects: [{ type: 'cancel' }, { type: 'save', text: s.text, expectedModified: s.modified }],
  };
}

export function editorStep(s: EditorState, e: EditorEvent): EditorStep {
  switch (e.type) {
    case 'edit': {
      const next = { ...s, text: e.text };
      if (s.conflict) return { state: next, effects: [] };
      const effect: EditorEffect = isDirty(next) ? { type: 'schedule', ms: EDITOR_SAVE_DELAY_MS } : { type: 'cancel' };
      return { state: next, effects: [effect] };
    }
    case 'saveRequested':
      // An in-flight save finishes first and then saves again if edits arrived meanwhile.
      if (s.saving || s.conflict || s.reloading || !isDirty(s)) return { state: s, effects: [] };
      return startSave(s);
    case 'saved': {
      const next: EditorState = {
        ...s,
        saving: false,
        savedText: s.savingText ?? s.text,
        savingText: null,
        modified: e.modified,
      };
      return isDirty(next) && !next.conflict ? startSave(next) : { state: next, effects: [] };
    }
    case 'saveFailed':
      return {
        state: { ...s, saving: false, savingText: null, conflict: s.conflict || e.conflict },
        effects: e.conflict ? [{ type: 'cancel' }] : [],
      };
    case 'diskChanged':
      // Our own save moves the modified time too; its result carries the new value.
      if (s.saving || s.conflict || e.modified === s.modified) return { state: s, effects: [] };
      // Unsaved edits are held until the read shows whether the content really moved; a
      // touch or a rewrite of the same bytes changes only the modified time.
      return { state: { ...s, reloading: true }, effects: [{ type: 'cancel' }, { type: 'reload' }] };
    case 'reloaded': {
      const read = { ...s, reloading: false };
      if (!s.conflict && isDirty(s)) {
        if (e.text === s.text) return { state: { ...read, savedText: e.text, modified: e.modified }, effects: [{ type: 'cancel' }] };
        if (e.text === s.savedText) {
          return { state: { ...read, modified: e.modified }, effects: [{ type: 'schedule', ms: EDITOR_SAVE_DELAY_MS }] };
        }
        return { state: { ...read, conflict: true }, effects: [{ type: 'cancel' }] };
      }
      return {
        state: { ...read, text: e.text, savedText: e.text, modified: e.modified, conflict: false },
        effects: [{ type: 'cancel' }, { type: 'setText', text: e.text }],
      };
    }
    case 'reloadFailed': {
      const next = { ...s, reloading: false };
      const resume = isDirty(next) && !next.conflict;
      return { state: next, effects: resume ? [{ type: 'schedule', ms: EDITOR_SAVE_DELAY_MS }] : [] };
    }
    case 'keepMine':
      return startSave({ ...s, modified: e.modified, conflict: false });
  }
}
