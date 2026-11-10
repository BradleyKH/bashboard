const SVG_NS = 'http://www.w3.org/2000/svg';

/** A line two-by-two grid of rounded squares, the top bar's Layouts menu button. */
export function gridIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.2');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x, y] of [
    [2, 2],
    [9, 2],
    [2, 9],
    [9, 9],
  ]) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', '5');
    rect.setAttribute('height', '5');
    rect.setAttribute('rx', '1');
    svg.append(rect);
  }
  return svg;
}
