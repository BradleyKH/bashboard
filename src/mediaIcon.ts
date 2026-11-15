const SVG_NS = 'http://www.w3.org/2000/svg';

export type MediaIconName =
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'shuffle'
  | 'repeat'
  | 'repeatOne'
  | 'volume'
  | 'muted'
  | 'note';

/** Filled shapes for the transport, outlines for the toggles around it. */
const FILLED: Partial<Record<MediaIconName, string[]>> = {
  play: ['M5 3.2v9.6a.6.6 0 0 0 .92.5l7.4-4.8a.6.6 0 0 0 0-1L5.92 2.7A.6.6 0 0 0 5 3.2Z'],
  pause: ['M4 3h2.6v10H4z', 'M9.4 3H12v10H9.4z'],
  next: ['M3 3.6v8.8a.5.5 0 0 0 .8.4L10 8.4a.5.5 0 0 0 0-.8L3.8 3.2a.5.5 0 0 0-.8.4Z', 'M11 3h2v10h-2z'],
  previous: ['M13 3.6v8.8a.5.5 0 0 1-.8.4L6 8.4a.5.5 0 0 1 0-.8l6.2-4.4a.5.5 0 0 1 .8.4Z', 'M3 3h2v10H3z'],
};

const STROKED: Partial<Record<MediaIconName, string[]>> = {
  shuffle: ['M2 4.5h2.2c1.4 0 2.2.7 3 1.8l1.6 2.4c.8 1.1 1.6 1.8 3 1.8H14', 'M2 11.5h2.2c1 0 1.7-.4 2.3-1', 'M9.5 5.5c.6-.6 1.3-1 2.3-1H14', 'M12.3 2.8 14 4.5l-1.7 1.7', 'M12.3 9.8 14 11.5l-1.7 1.7'],
  repeat: ['M3 7.5V6.5A2 2 0 0 1 5 4.5h8', 'M11.3 2.8 13 4.5l-1.7 1.7', 'M13 8.5v1a2 2 0 0 1-2 2H3', 'M4.7 13.2 3 11.5l1.7-1.7'],
  repeatOne: ['M3 7.5V6.5A2 2 0 0 1 5 4.5h8', 'M11.3 2.8 13 4.5l-1.7 1.7', 'M13 8.5v1a2 2 0 0 1-2 2H3', 'M4.7 13.2 3 11.5l1.7-1.7', 'M7.4 7l1-.6v3.4'],
  volume: ['M2.5 6h2.2L8 3.3v9.4L4.7 10H2.5Z', 'M10.5 5.8a3 3 0 0 1 0 4.4', 'M12.2 4a5.5 5.5 0 0 1 0 8'],
  muted: ['M2.5 6h2.2L8 3.3v9.4L4.7 10H2.5Z', 'M10.5 6.2l3 3.6', 'M13.5 6.2l-3 3.6'],
  note: ['M6 12V3.5l7-1.5V10.5', 'M6 6l7-1.5'],
};

/** One of the Media section's 16 px icons, colored by `currentColor`. */
export function mediaIcon(name: MediaIconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const filled = FILLED[name];
  if (filled) {
    svg.setAttribute('fill', 'currentColor');
  } else {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  for (const d of filled ?? STROKED[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  if (name === 'note') {
    for (const [cx, cy] of [
      [4.5, 12],
      [11.5, 10.5],
    ]) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', '1.6');
      svg.appendChild(c);
    }
  }
  return svg;
}
