import type { FindResults, TerminalPane } from './pane';

/**
 * Find in scrollback (docs/design.md section 4.4): one bar, attached over the top-right corner
 * of a pane's host. Enter is next, Shift+Enter previous, Esc closes.
 */
export class FindBar {
  private readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private pane: TerminalPane | null = null;
  private results: { dispose(): void } | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'find-bar';
    this.input = document.createElement('input');
    this.input.className = 'find-input';
    this.input.type = 'text';
    this.input.placeholder = 'Find';
    this.input.spellcheck = false;
    this.count = document.createElement('span');
    this.count.className = 'find-count';
    this.el.append(
      this.input,
      this.count,
      this.button('↑', 'Previous match (Shift+Enter)', () => this.step('previous')),
      this.button('↓', 'Next match (Enter)', () => this.step('next')),
      this.button('×', 'Close (Esc)', () => this.close()),
    );
    this.input.addEventListener('input', () => this.search());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Opens on `pane`, or refocuses and selects the input if already open there. */
  open(pane: TerminalPane, host: HTMLElement): void {
    if (this.pane !== pane) {
      this.close(false);
      this.pane = pane;
      this.results = pane.onFindResults((r) => this.showResults(r));
      host.append(this.el);
      this.count.textContent = '';
      if (this.input.value !== '') this.search();
    }
    this.input.focus();
    this.input.select();
  }

  /** Clears highlights; `refocus` returns focus to the terminal it was searching. */
  close(refocus = true): void {
    const pane = this.pane;
    if (!pane) return;
    this.pane = null;
    this.results?.dispose();
    this.results = null;
    pane.clearFind();
    this.el.remove();
    if (refocus) pane.focus();
  }

  isOpen(): boolean {
    return this.pane !== null;
  }

  isOpenOn(pane: TerminalPane | undefined): boolean {
    return pane !== undefined && this.pane === pane;
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
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

  private search(): void {
    const pane = this.pane;
    if (!pane) return;
    const query = this.input.value;
    if (query === '') {
      pane.clearFind();
      this.count.textContent = '';
      return;
    }
    if (!pane.find(query, 'next')) this.count.textContent = 'No results';
  }

  private step(direction: 'next' | 'previous'): void {
    const query = this.input.value;
    if (!this.pane || query === '') return;
    if (!this.pane.find(query, direction)) this.count.textContent = 'No results';
  }

  private showResults({ resultIndex, resultCount }: FindResults): void {
    if (resultCount === 0) this.count.textContent = 'No results';
    // The addon reports -1 once the match count passes its highlight limit.
    else if (resultIndex < 0) this.count.textContent = `${resultCount}+ matches`;
    else this.count.textContent = `${resultIndex + 1} of ${resultCount}`;
  }
}
