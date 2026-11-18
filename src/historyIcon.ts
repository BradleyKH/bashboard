const SVG_NS = 'http://www.w3.org/2000/svg';

/** A clock with a counterclockwise arrow, the title strip's Sessions button. */
export function historyIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M2.6 8a5.4 5.4 0 1 0 1.6-3.8M1.9 2.4v2.4h2.4M8 5v3.2l2.1 1.3');
  svg.append(path);
  return svg;
}

/** A title strip button that opens the Sessions dialog (docs/design/terminal.md section 4.4). */
export function historyStripButton(title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'strip-action';
  b.append(historyIcon());
  b.title = title;
  b.setAttribute('aria-label', 'Sessions');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
