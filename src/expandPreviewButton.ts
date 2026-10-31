const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The toolbar button that makes a Files pane's preview fill the pane, and brings the list back.
 * The icon is a side panel with an arrow, kept unlike the title strip's zoom glyphs since both
 * show at once.
 */
export class ExpandPreviewButton {
  readonly el: HTMLButtonElement;

  constructor(onClick: () => void) {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'preview-expand';
    this.el.addEventListener('click', onClick);
    this.set(false);
  }

  set(expanded: boolean): void {
    const label = expanded ? 'Show file list' : 'Expand preview';
    this.el.title = expanded ? 'Show file list (Esc)' : label;
    this.el.setAttribute('aria-label', label);
    this.el.setAttribute('aria-pressed', String(expanded));
    this.el.replaceChildren(icon(expanded));
  }
}

function icon(expanded: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const shapes: [string, Record<string, string>][] = [
    ['rect', { x: '1.5', y: '2.5', width: '13', height: '11', rx: '2' }],
    ['line', { x1: '6', y1: '2.5', x2: '6', y2: '13.5' }],
    ['path', { d: expanded ? 'M8.5 8h4M10.8 6.2 12.6 8l-1.8 1.8' : 'M12.5 8h-4M10.2 6.2 8.4 8l1.8 1.8' }],
  ];
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}
