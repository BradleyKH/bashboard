const SVG_NS = 'http://www.w3.org/2000/svg';

/** A line globe (an outline, a meridian, and the equator), the mark for global pins. */
export function globeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.2');
  svg.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS(SVG_NS, 'circle');
  outline.setAttribute('cx', '8');
  outline.setAttribute('cy', '8');
  outline.setAttribute('r', '6.4');
  const meridian = document.createElementNS(SVG_NS, 'ellipse');
  meridian.setAttribute('cx', '8');
  meridian.setAttribute('cy', '8');
  meridian.setAttribute('rx', '2.8');
  meridian.setAttribute('ry', '6.4');
  const lines = document.createElementNS(SVG_NS, 'path');
  lines.setAttribute('d', 'M1.6 8h12.8M2.6 4.8h10.8M2.6 11.2h10.8');
  svg.append(outline, meridian, lines);
  return svg;
}
