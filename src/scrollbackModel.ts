/** The line written under restored scrollback, in gray, so new output reads apart from the old. */
export const RESTORED_SEPARATOR = '\x1b[0m\r\n\x1b[90m──────── restored scrollback ────────\x1b[0m\r\n';

/**
 * What a restored terminal writes before its shell starts: the saved scrollback and a separator,
 * or nothing when the saved text is blank. A saved buffer ends on the prompt line it closed on,
 * so the separator starts a fresh line under it.
 */
export function replayText(saved: string): string {
  return saved.trim() === '' ? '' : saved + RESTORED_SEPARATOR;
}
