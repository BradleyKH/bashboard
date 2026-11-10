/**
 * Detects a file's indentation so Tab in the text editor matches it (docs/design/files.md
 * section 4.22, Editor behavior). Pure, no DOM.
 */

/** Lines past this are not read; the top of a file sets its style. */
const MAX_LINES = 5000;

/** Files whose syntax requires tabs, used when the text has no indented lines to go by. */
const TAB_NAMES = new Set(['makefile', 'gnumakefile']);
const TAB_EXTENSIONS = new Set(['.go', '.mk']);

/**
 * The indent unit for `text`: `'\t'` when more lines start with a tab than with spaces, else the
 * most common step between the space indents of successive lines (2 to 8). With nothing to go by,
 * a tab for Makefiles and Go, else two spaces.
 */
export function detectIndentUnit(text: string, path = ''): string {
  let tabLines = 0;
  let spaceLines = 0;
  const steps = new Map<number, number>();
  let prev = 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (++count > MAX_LINES) break;
    if (line.trim() === '') continue;
    if (line[0] === '\t') {
      tabLines++;
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (width > 0) spaceLines++;
    // Only steps in: a dedent can close several levels at once. A step of 1 is usually the
    // ` * ` of a block comment, not a level.
    const step = width - prev;
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    prev = width;
  }
  if (tabLines > spaceLines) return '\t';
  let best = 0;
  let bestCount = 0;
  for (const [step, n] of steps) {
    // A tie goes to the smaller step, since a 2-space file also steps by 4 where it skips a level.
    if (n > bestCount || (n === bestCount && step < best)) {
      best = step;
      bestCount = n;
    }
  }
  if (best > 0) return ' '.repeat(best);
  if (spaceLines === 0 && requiresTabs(path)) return '\t';
  return '  ';
}

function requiresTabs(path: string): boolean {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (TAB_NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && TAB_EXTENSIONS.has(name.slice(dot));
}
