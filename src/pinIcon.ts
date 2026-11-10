const SVG_NS = 'http://www.w3.org/2000/svg';

/** A line pushpin (a cap, a flared body, and the needle), the top bar's global pins menu button. */
export function pinIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M5 1.6h6M6.4 1.6v4.2L4 9.2h8L9.6 5.8V1.6M8 9.2v5.2');
  svg.append(path);
  return svg;
}
