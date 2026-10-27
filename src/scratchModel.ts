/** Scratch pad text rules (docs/design.md section 4.15). */

/** Half a second after typing stops, the pad's text is saved. */
export const SCRATCH_SAVE_DELAY_MS = 500;

const TITLE_MAX = 32;
const FALLBACK_TITLE = 'Scratch';

/**
 * The first non-empty line, trimmed and shortened to 32 characters (the ellipsis counts toward
 * the 32), or "Scratch" when the pad has no text.
 */
export function scratchTitle(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return FALLBACK_TITLE;
  if (line.length <= TITLE_MAX) return line;
  return `${line.slice(0, TITLE_MAX - 3)}...`;
}

/** A pad is empty when its text is blank; empty pads are not kept in layouts or confirmed on close. */
export function isScratchEmpty(text: string): boolean {
  return text.trim().length === 0;
}

export function newScratchId(): string {
  return crypto.randomUUID();
}
