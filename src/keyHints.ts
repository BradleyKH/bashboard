import { withKeys } from './dashboardRevealModel';
import type { KeybindingEntry } from './keymap';
import { chordHint } from './paletteModel';

// The live keybindings, so a button's tooltip names the keys as currently bound rather than the
// defaults; main.ts sets them at startup and on every settings reload.
let bindings: KeybindingEntry[] = [];

export function setKeyHintBindings(entries: KeybindingEntry[]): void {
  bindings = entries;
}

/** Every chord bound to `action`, formatted, or undefined when none is. */
export function keyHint(action: string): string | undefined {
  return chordHint(bindings, action);
}

const hinted = new WeakMap<HTMLElement, { title: string; action: string }>();

/**
 * Sets `el`'s tooltip to `title` with `action`'s keys in parentheses. Only for a button that does
 * exactly what the action does; the keys are re-read on hover, so a rebinding shows without a
 * re-render. Safe to call again with a new title.
 */
export function setHintedTitle(el: HTMLElement, title: string, action: string): void {
  if (!hinted.has(el)) {
    el.addEventListener('pointerenter', () => {
      const h = hinted.get(el);
      if (h) el.title = withKeys(h.title, keyHint(h.action));
    });
  }
  hinted.set(el, { title, action });
  el.title = withKeys(title, keyHint(action));
}
