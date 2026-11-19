import { SHIP_ICON } from './paneKinds';
import { rocketIcon } from './rocketIcon';

/**
 * Shows a pane kind's icon in `el`: its text glyph, or an SVG for the one kind no font draws
 * in one color everywhere (the Ship rocket). Leaves `el` alone when it already shows `icon`.
 */
export function setGlyphIcon(el: Element, icon: string): void {
  if (el.getAttribute('data-glyph') === icon) return;
  el.setAttribute('data-glyph', icon);
  if (icon === SHIP_ICON) el.replaceChildren(rocketIcon());
  else el.textContent = icon;
}
