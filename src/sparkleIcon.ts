const SVG_NS = 'http://www.w3.org/2000/svg';

/** A large and a small four-point sparkle, the usual mark for AI; `filled` marks a toggle that is on. */
export function sparkleIcon(filled: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.2');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = [
    'M6.5 3c.6 3.3 1.7 4.8 5.5 6c-3.8 1.2-4.9 2.7-5.5 6c-.6-3.3-1.7-4.8-5.5-6c3.8-1.2 4.9-2.7 5.5-6Z',
    'M12.5 1c.2 1.2.6 1.6 1.8 2c-1.2.4-1.6.8-1.8 2c-.2-1.2-.6-1.6-1.8-2c1.2-.4 1.6-.8 1.8-2Z',
  ];
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
