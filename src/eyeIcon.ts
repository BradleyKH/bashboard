const SVG_NS = 'http://www.w3.org/2000/svg';

/** An open eye, or with `slashed` a struck-through one: a toggle that shows or hides rows. */
export function eyeIcon(slashed: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = ['M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z'];
  if (slashed) paths.push('M2.5 13.5l11-11');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  const pupil = document.createElementNS(SVG_NS, 'circle');
  pupil.setAttribute('cx', '8');
  pupil.setAttribute('cy', '8');
  pupil.setAttribute('r', '2');
  svg.appendChild(pupil);
  return svg;
}
