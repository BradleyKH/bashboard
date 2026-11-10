/** A 1-based line and optional 1-based column, as typed into the Go to line bar. */
export interface LineTarget {
  line: number;
  column: number | null;
}

/**
 * Parses `42` or `42:7` (the compiler's `line:column` form; `42,7` too). Surrounding spaces are
 * ignored; anything else, including zero, is null so the bar leaves the view alone.
 */
export function parseLineTarget(text: string): LineTarget | null {
  const m = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(text);
  if (!m) return null;
  const line = Number(m[1]);
  const column = m[2] === undefined ? null : Number(m[2]);
  if (line < 1 || (column !== null && column < 1)) return null;
  return { line, column };
}
