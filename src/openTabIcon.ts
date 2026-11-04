const SVG_NS = 'http://www.w3.org/2000/svg';

/** An arrow leaving a square: a dashboard section's button that opens its pane's tab. */
export function openTabIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M13.5 9v3.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5h3.5', 'M13.5 2.5 8 8', 'M10 2.5h3.5V6']) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** The section header button that opens a pane kind's tab. */
export function openTabButton(title: string, label: string, onClick: () => void): HTMLButtonElement {
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'section-open';
  open.append(openTabIcon());
  open.title = title;
  open.setAttribute('aria-label', label);
  open.addEventListener('click', onClick);
  return open;
}
