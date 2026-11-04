import { tourSections, type TourPart } from './helpTour';
import type { KeybindingEntry } from './keymap';
import type { SetupStatus } from './setupStatus';
import { linkButton } from './dialogLink';

const USER_GUIDE_URL = 'https://github.com/BradleyKH/bashboard/blob/main/docs/user-guide.md';

/** The app dialog's Help tab: a short tour with the live keys, then the setup status. */
export class HelpTab {
  private root: HTMLElement | null = null;
  private tour: HTMLElement | null = null;

  constructor(private readonly status: SetupStatus) {}

  mount(host: HTMLElement, entries: KeybindingEntry[]): void {
    const root = document.createElement('div');
    root.className = 'help-tab app-dialog-scroll';
    const tour = document.createElement('div');
    tour.className = 'help-tab-tour';
    const more = document.createElement('p');
    more.className = 'app-dialog-note';
    more.append('The full ', linkButton('user guide', USER_GUIDE_URL), ' covers every feature.');
    root.append(tour, more, this.status.element);
    host.append(root);
    this.root = root;
    this.tour = tour;
    this.update(entries);
    void this.status.refresh();
  }

  /** Each visit rechecks the setup, since a fix may have happened outside the dialog. */
  show(): void {
    if (this.root) void this.status.refresh();
  }

  update(entries: KeybindingEntry[]): void {
    if (!this.tour) return;
    this.tour.replaceChildren(
      ...tourSections(entries).map((s) => {
        const el = document.createElement('section');
        const h = document.createElement('h3');
        h.textContent = s.title;
        el.append(h, ...s.paragraphs.map((p) => paragraph(p)));
        return el;
      }),
    );
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.tour = null;
  }
}

function paragraph(parts: TourPart[]): HTMLElement {
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
