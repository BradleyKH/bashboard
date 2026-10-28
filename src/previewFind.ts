import { findMatches, matchAtOrAfter, matchCountText, stepMatch, type FindMatches } from './previewFindModel';

/** What a preview view offers the find bar. */
export interface FindSurface {
  /** The element whose text is searched and highlighted. */
  readonly textRoot: HTMLElement;
  /** Scrolls so `range` is in view. */
  reveal(range: Range): void;
  /** The bar closed; `range` is the current match, or null. Takes focus back. */
  done(range: Range | null): void;
}

interface SharedHighlights {
  all: Highlight;
  current: Highlight;
}

let shared: SharedHighlights | null = null;

/**
 * Highlight names are page-wide, so every preview's find bar adds its ranges to the same two
 * highlights and removes only its own.
 */
function highlights(): SharedHighlights {
  if (!shared) {
    const all = new Highlight();
    const current = new Highlight();
    current.priority = 1;
    CSS.highlights.set('preview-find', all);
    CSS.highlights.set('preview-find-current', current);
    shared = { all, current };
  }
  return shared;
}

/**
 * The Find button and bar on a file preview's toolbar (docs/design.md section 4.12). Enter is
 * next, Shift+Enter previous, Esc closes.
 */
export class PreviewFind {
  readonly button: HTMLButtonElement;
  readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly surface: () => FindSurface | null;
  private readonly observer: MutationObserver;
  private observed: HTMLElement | null = null;
  private ranges: Range[] = [];
  private found: FindMatches = { ranges: [], capped: false };
  private index = -1;

  constructor(surface: () => FindSurface | null) {
    this.surface = surface;
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.textContent = 'Find';
    this.button.title = 'Find in this file (Ctrl+Shift+F)';
    this.button.addEventListener('click', () => this.open());

    this.bar = document.createElement('div');
    this.bar.className = 'preview-find';
    this.bar.hidden = true;
    this.input = document.createElement('input');
    this.input.className = 'find-input';
    this.input.type = 'text';
    this.input.placeholder = 'Find';
    this.input.spellcheck = false;
    this.count = document.createElement('span');
    this.count.className = 'find-count';
    this.bar.append(
      this.input,
      this.count,
      this.barButton('↑', 'Previous match (Shift+Enter)', () => this.step('previous')),
      this.barButton('↓', 'Next match (Enter)', () => this.step('next')),
      this.barButton('×', 'Close (Esc)', () => this.close()),
    );
    this.input.addEventListener('input', () => this.search(true));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    // The view's text was replaced (a reload, an edit, a re-render): the old ranges are stale.
    this.observer = new MutationObserver(() => this.search(false));
  }

  get isOpen(): boolean {
    return !this.bar.hidden;
  }

  /** Shows the bar, or refocuses and selects its input if already open. */
  open(): void {
    if (!this.isOpen) {
      this.bar.hidden = false;
      this.button.hidden = true;
      this.refresh();
    }
    this.input.focus();
    this.input.select();
  }

  /** The view switched what it shows (such as markdown's Edit toggle); searches the new surface. */
  refresh(): void {
    if (this.isOpen) this.search(true);
  }

  close(): void {
    if (!this.isOpen) return;
    const range = this.ranges[this.index] ?? null;
    this.reset();
    this.surface()?.done(range);
  }

  dispose(): void {
    this.reset();
    this.bar.remove();
    this.button.remove();
  }

  private reset(): void {
    this.bar.hidden = true;
    this.button.hidden = false;
    this.observer.disconnect();
    this.observed = null;
    this.setRanges([], -1);
    this.found = { ranges: [], capped: false };
    this.count.textContent = '';
  }

  private search(reveal: boolean): void {
    const surface = this.surface();
    if (!this.isOpen || !surface) return;
    this.observe(surface.textRoot);
    const query = this.input.value;
    const map = textMap(surface.textRoot);
    // Stays on the same match, or the next one, as the text changes under it.
    const anchor = this.found.ranges[this.index]?.[0] ?? 0;
    this.found = findMatches(map.text, query);
    const ranges = this.found.ranges.map(([start, end]) => map.range(start, end));
    this.setRanges(ranges, matchAtOrAfter(this.found.ranges, anchor));
    this.showCount(query);
    if (reveal) this.revealCurrent(surface);
  }

  private step(direction: 'next' | 'previous'): void {
    const surface = this.surface();
    if (!surface || this.ranges.length === 0) return;
    this.setRanges(this.ranges, stepMatch(this.index, this.ranges.length, direction));
    this.showCount(this.input.value);
    this.revealCurrent(surface);
  }

  private setRanges(ranges: Range[], index: number): void {
    const { all, current } = highlights();
    for (const r of this.ranges) all.delete(r);
    const old = this.ranges[this.index];
    if (old) current.delete(old);
    this.ranges = ranges;
    this.index = index;
    for (const r of ranges) all.add(r);
    const now = ranges[index];
    if (now) current.add(now);
  }

  private revealCurrent(surface: FindSurface): void {
    const range = this.ranges[this.index];
    if (range) surface.reveal(range);
  }

  private showCount(query: string): void {
    this.count.textContent = matchCountText(query, this.index, this.found);
  }

  private observe(root: HTMLElement): void {
    if (this.observed === root) return;
    this.observer.disconnect();
    this.observer.observe(root, { childList: true, characterData: true, subtree: true });
    this.observed = root;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      this.step(e.shiftKey ? 'previous' : 'next');
    } else if (e.key === 'Escape') {
      this.close();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private barButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'find-button';
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    // Keeps focus in the input, so Enter keeps stepping after a click.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', onClick);
    return b;
  }
}

/** Scrolls `scroller` so `range` sits a third of the way in, when it is out of view. */
export function revealIn(scroller: HTMLElement, range: Range): void {
  const r = range.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  const top = r.top - s.top;
  if (top < 0 || top + r.height > scroller.clientHeight) scroller.scrollTop += top - scroller.clientHeight / 3;
  const left = r.left - s.left;
  if (left < 0 || left + r.width > scroller.clientWidth) scroller.scrollLeft += left - scroller.clientWidth / 3;
}

/** Selects `range` in the page, so Ctrl+C copies the match after the bar closes. */
export function selectRange(range: Range | null): void {
  const sel = window.getSelection();
  if (!sel || !range) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The text under `root` as one string, with a way back from offsets to DOM ranges. */
function textMap(root: HTMLElement): { text: string; range(start: number, end: number): Range } {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  // The node holding `offset`; an end offset belongs to the node it closes.
  const locate = (offset: number, isEnd: boolean): [Text, number] => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (isEnd ? starts[mid] < offset : starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], offset - starts[lo]];
  };
  return {
    text,
    range(start, end) {
      const r = document.createRange();
      r.setStart(...locate(start, false));
      r.setEnd(...locate(end, true));
      return r;
    },
  };
}
