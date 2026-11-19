const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A line rocket, the Ship pane's mark. An SVG rather than U+1F680: on Linux and macOS the only
 * font with that character is a color emoji font, which ignores the U+FE0E text request.
 */
export function rocketIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.2');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('glyph-icon');
  // The body points up and right, with a window, two fins, and an exhaust trail.
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('d', 'M14 2c-3.6.2-6.4 2.2-8 5.4L8.6 10c3.2-1.6 5.2-4.4 5.4-8Z');
  const fins = document.createElementNS(SVG_NS, 'path');
  fins.setAttribute('d', 'M6 7.4 3.4 7.6 2 9.4l2.8.4M8.6 10l-.2 2.6L6.6 14l-.4-2.8');
  const exhaust = document.createElementNS(SVG_NS, 'path');
  exhaust.setAttribute('d', 'M4.8 11.2 2.4 13.6');
  const window = document.createElementNS(SVG_NS, 'circle');
  window.setAttribute('cx', '10.4');
  window.setAttribute('cy', '5.6');
  window.setAttribute('r', '1.1');
  svg.append(body, fins, exhaust, window);
  return svg;
}
