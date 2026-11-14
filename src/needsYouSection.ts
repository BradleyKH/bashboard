// shipPane.css carries the status icon classes; the dashboard can render before any Ship pane exists.
import './shipPane.css';
import './needsYouSection.css';
import { attachContextMenu } from './contextMenu';
import { item as menuItem } from './contextMenuModel';
import { statusInfo } from './shipModel';
import { ageOf, hideKey, phrase, statusIcon, subject, tooltip, visibleRows, type NeedsItem } from './needsYouModel';

export interface NeedsYouSectionCallbacks {
  /** A row was clicked; the owner opens the thing it is about. */
  onActivate(item: NeedsItem): void;
  /** "Hide until it changes" was chosen on a row whose `hideKey` is non-null. */
  onHide(item: NeedsItem): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 2 * pi * r for the meter's r of 5.5 in a 14-unit box. */
const RING_LENGTH = 34.56;

/** The dashboard's Needs you section: everything the user should act on, in order (docs/design/dashboard.md section 4.28). */
export class NeedsYouSection {
  readonly el: HTMLElement;
  /** The heading, which is also the collapse handle. */
  readonly head: HTMLElement;
  private readonly list: HTMLElement;
  private expanded = false;
  private items: readonly NeedsItem[] = [];
  private now = Date.now();

  constructor(private readonly callbacks: NeedsYouSectionCallbacks) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section needs-you-section';

    this.head = document.createElement('h2');
    this.head.textContent = 'Needs you';

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
    this.update([], this.now);
  }

  /** Renders `items`, already ordered with hides applied; `now` is what ages are measured against. */
  update(items: readonly NeedsItem[], now: number): void {
    this.items = items;
    this.now = now;
    this.render();
  }

  private render(): void {
    if (this.items.length === 0) {
      this.list.replaceChildren(this.emptyRow());
      return;
    }
    const { shown, more, overflowing } = visibleRows(this.items, this.expanded);
    const rows = shown.map((item) => this.itemRow(item));
    if (overflowing) rows.push(this.moreRow(this.expanded ? 'Show fewer' : `+ ${more} more`));
    this.list.replaceChildren(...rows);
  }

  private emptyRow(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'needs-empty';
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 14 14');
    icon.classList.add('needs-icon');
    const check = document.createElementNS(SVG_NS, 'path');
    check.setAttribute('d', 'M3.5 7.4l2.3 2.3 4.7-5');
    icon.append(check);
    const text = document.createElement('span');
    text.textContent = 'Nothing needs you';
    el.append(icon, text);
    return el;
  }

  private moreRow(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'favorite-row needs-row needs-more';
    el.textContent = text;
    el.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.render();
    });
    return el;
  }

  private itemRow(item: NeedsItem): HTMLElement {
    const el = document.createElement('div');
    el.className = 'favorite-row needs-row';
    el.title = tooltip(item);

    const subjectEl = document.createElement('span');
    subjectEl.className = 'needs-subject';
    subjectEl.textContent = subject(item);

    const phraseEl = document.createElement('span');
    phraseEl.className = 'needs-phrase';
    phraseEl.textContent = phrase(item);

    const ageEl = document.createElement('span');
    ageEl.className = 'needs-age';
    ageEl.textContent = ageOf(item, this.now);

    el.append(this.icon(item), subjectEl, phraseEl, ageEl);
    el.addEventListener('click', () => this.callbacks.onActivate(item));
    attachContextMenu(el, () => ({
      entries:
        hideKey(item) === null
          ? [menuItem('Clears when the agent moves on', () => {}, { enabled: false })]
          : [menuItem('Hide until it changes', () => this.callbacks.onHide(item))],
      target: el,
    }));
    return el;
  }

  private icon(item: NeedsItem): HTMLElement | SVGElement {
    if (item.kind !== 'usage') {
      const icon = document.createElement('span');
      icon.className = `ship-status ship-status--${statusInfo(statusIcon(item)).modifier}`;
      return icon;
    }
    // A ring filled to the window's percent; at 100 it reads as the failure it is.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.classList.add('needs-icon', 'needs-meter');
    if (item.percent >= 100) svg.classList.add('needs-meter--full');
    const track = document.createElementNS(SVG_NS, 'circle');
    const fill = document.createElementNS(SVG_NS, 'circle');
    for (const c of [track, fill]) {
      c.setAttribute('cx', '7');
      c.setAttribute('cy', '7');
      c.setAttribute('r', '5.5');
    }
    track.classList.add('needs-meter-track');
    fill.classList.add('needs-meter-fill');
    const pct = Math.max(0, Math.min(100, item.percent));
    fill.setAttribute('stroke-dasharray', `${(pct / 100) * RING_LENGTH} 40`);
    fill.setAttribute('transform', 'rotate(-90 7 7)');
    svg.append(track, fill);
    return svg;
  }
}
