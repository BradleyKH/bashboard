import { kindIconShapes } from './kindIconShapes';
import { SHIP_ICON } from './paneKinds';
import { platformOs } from './platform';
import { rocketIcon } from './rocketIcon';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Shows a pane kind's icon in `el`: on Linux and macOS a line drawing (the rocket for Ship,
 * kindIconShapes.ts for the rest), since there the text glyphs fall back across fonts of
 * different sizes; on Windows, and for any other glyph, the text itself. Leaves `el` alone when
 * it already shows `icon`.
 */
export function setGlyphIcon(el: Element, icon: string): void {
  if (el.getAttribute('data-glyph') === icon) return;
  el.setAttribute('data-glyph', icon);
  const svg = platformOs() === 'windows' ? null : icon === SHIP_ICON ? rocketIcon() : kindIcon(icon);
  if (svg) el.replaceChildren(svg);
  else el.textContent = icon;
}

function kindIcon(icon: string): SVGSVGElement | null {
  const shapes = kindIconShapes(icon);
  if (!shapes) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.2');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('glyph-icon');
  for (const shape of shapes) {
    if ('path' in shape) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', shape.path);
      svg.append(path);
    } else {
      const [cx, cy, r] = shape.circle;
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r));
      svg.append(circle);
    }
  }
  return svg;
}
