import type { TourPart } from './helpTour';

/** One paragraph of tour text, with each action's live keys as `<kbd>`s. */
export function tourPartsElement(parts: TourPart[]): HTMLElement {
  const p = document.createElement('p');
  for (const part of parts) {
    if ('text' in part) {
      p.append(part.text);
    } else if ('keys' in part) {
      part.keys.forEach((k, i) => {
        if (i > 0) p.append(' or ');
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        p.append(kbd);
      });
    } else {
      const span = document.createElement('span');
      span.className = 'help-tab-unbound';
      span.textContent = 'no key';
      span.title = `Bind ${part.unbound} in the Shortcuts tab, or run it from the command palette`;
      p.append(span);
    }
  }
  return p;
}
