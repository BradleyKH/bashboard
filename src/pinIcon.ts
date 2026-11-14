const SVG_NS = 'http://www.w3.org/2000/svg';

/** A line pushpin (a cap, a flared body, and the needle), the dashboard top bar's pin button. */
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

const FILLED_PIN_PATH =
  'M10.2 1.3a.75.75 0 0 1 1.06 0l3.44 3.44a.75.75 0 0 1 0 1.06l-.7.7a1.5 1.5 0 0 1-1.42.4l-2.2 2.2' +
  ' .33 2.3a.75.75 0 0 1-.21.64l-.72.72a.75.75 0 0 1-1.06 0L6.2 10.24 2.53 13.9a.5.5 0 0 1-.71-.7L5.5 9.53' +
  ' 2.98 7.01a.75.75 0 0 1 0-1.06l.72-.72a.75.75 0 0 1 .64-.21l2.3.33 2.2-2.2a1.5 1.5 0 0 1 .4-1.42z';

/** A filled, tilted pushpin: the title strip's pin buttons and the Files breadcrumb's. */
export function filledPinIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', FILLED_PIN_PATH);
  svg.append(path);
  return svg;
}

/** A title strip pin button that drops a pin picker from itself (docs/design/terminal.md section 4.4). */
export function pinStripButton(title: string, onClick: (anchor: HTMLElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'strip-action';
  b.append(filledPinIcon());
  b.title = title;
  b.setAttribute('aria-label', 'Pins');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(b);
  });
  return b;
}
