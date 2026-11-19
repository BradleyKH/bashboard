import { SHIP_ICON } from './paneKinds';
import { platformOs } from './platform';
import { rocketIcon } from './rocketIcon';

/**
 * Shows a pane kind's icon in `el`: its text glyph, or on Linux and macOS an SVG for the Ship
 * rocket, whose only font there is a color emoji. Windows keeps the glyph, since Segoe UI
 * Symbol draws it in one color. Leaves `el` alone when it already shows `icon`.
 */
export function setGlyphIcon(el: Element, icon: string): void {
  if (el.getAttribute('data-glyph') === icon) return;
  el.setAttribute('data-glyph', icon);
  if (icon === SHIP_ICON && platformOs() !== 'windows') el.replaceChildren(rocketIcon());
  else el.textContent = icon;
}
