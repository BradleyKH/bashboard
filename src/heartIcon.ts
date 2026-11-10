const SVG_NS = 'http://www.w3.org/2000/svg';

/** A line heart, the top bar's Favorites menu button. */
export function heartIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M8 13.6 2.6 8.3A3.1 3.1 0 0 1 8 4.4a3.1 3.1 0 0 1 5.4 3.9Z');
  svg.append(path);
  return svg;
}
