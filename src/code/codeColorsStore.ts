/** Whether code surfaces color by language or show every character in the content text color (docs/design/files.md section 4.22). */
export type CodeColorsMode = 'syntax' | 'plain';

/** workspace.json's `codeColors`; anything but `'plain'` is Syntax, the default. */
export function parseCodeColorsMode(raw: unknown): CodeColorsMode {
  return raw === 'plain' ? 'plain' : 'syntax';
}

let current: CodeColorsMode = 'syntax';
let listener: (() => void) | null = null;

/** The mode a newly opened pane starts in: the latest choice made in any pane. */
export function codeColorsDefault(): CodeColorsMode {
  return current;
}

/** Restores the mode from workspace.json, before any pane is built. */
export function loadCodeColorsDefault(mode: CodeColorsMode): void {
  current = mode;
}

/** A pane's toggle was used; the next pane starts in `mode`. */
export function setCodeColorsDefault(mode: CodeColorsMode): void {
  current = mode;
  listener?.();
}

/** One listener, the workspace saver. */
export function onCodeColorsDefaultChange(fn: () => void): void {
  listener = fn;
}
