/**
 * Which elements count as text fields for the text field menu (docs/design/terminal.md section
 * 4.4). Kept apart from `textFieldMenu.ts`, which imports `contextMenu.ts`, so both can share it.
 */

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/**
 * A textarea, a text-like input, or anything inside a CodeMirror editor's content (a right-click
 * lands on a line or a token span), outside a terminal (xterm.js's helper textarea is not one).
 */
export function isTextField(el: Element | null): el is HTMLElement {
  if (!el || el.closest('.xterm')) return false;
  if (el.closest('.cm-content')) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  return tag === 'INPUT' && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}
