import './tourCard.css';
import type { TourPart } from './helpTour';
import { tourPartsElement } from './tourPartsView';

export interface TourCardCallbacks {
  onNext(): void;
  onSkip(): void;
  /** The finish card's buttons; `closePanes` closes the panes the tour opened. */
  onFinish(closePanes: boolean): void;
}

export interface TourStepView {
  index: number;
  count: number;
  title: string;
  parts: TourPart[];
  /** The step just finished; shows a check mark until the next step replaces it. */
  done: boolean;
}

/**
 * The tour's card at the bottom of the window (docs/design/app.md section 4.29). It never takes
 * focus, so the keys each step asks for still reach the focused pane.
 */
export class TourCard {
  private el: HTMLElement | null = null;

  constructor(private readonly callbacks: TourCardCallbacks) {}

  showStep(view: TourStepView): void {
    const card = this.mount();
    const counter = document.createElement('div');
    counter.className = 'tour-card-counter';
    counter.textContent = `Tour · ${view.index + 1} of ${view.count}`;
    const title = document.createElement('h2');
    title.textContent = view.done ? `✓ ${view.title}` : view.title;
    if (view.done) title.classList.add('tour-card-done');
    const footer = this.footer(
      [this.button('Skip tour', () => this.callbacks.onSkip(), 'tour-card-skip')],
      [this.button(view.index + 1 === view.count ? 'Finish' : 'Next', () => this.callbacks.onNext(), 'tour-card-primary')],
    );
    card.replaceChildren(counter, title, tourPartsElement(view.parts), footer);
  }

  /** `closable` is how many panes the tour opened that are still open. */
  showFinish(closable: number): void {
    const card = this.mount();
    const title = document.createElement('h2');
    title.textContent = "You're set";
    const text = document.createElement('p');
    text.textContent =
      closable > 0
        ? `Keep the ${closable === 1 ? 'pane' : `${closable} panes`} the tour opened, or close ${closable === 1 ? 'it' : 'them'}?`
        : 'Enjoy Bashboard.';
    const right =
      closable > 0
        ? [
            this.button(closable === 1 ? 'Close it' : 'Close them', () => this.callbacks.onFinish(true)),
            this.button('Keep', () => this.callbacks.onFinish(false), 'tour-card-primary'),
          ]
        : [this.button('Done', () => this.callbacks.onFinish(false), 'tour-card-primary')];
    card.replaceChildren(title, text, this.footer([], right));
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  isShown(): boolean {
    return this.el !== null;
  }

  private mount(): HTMLElement {
    if (this.el) return this.el;
    const el = document.createElement('div');
    el.className = 'tour-card';
    el.setAttribute('role', 'status');
    document.body.append(el);
    this.el = el;
    return el;
  }

  private footer(left: HTMLElement[], right: HTMLElement[]): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'tour-card-footer';
    const nav = document.createElement('div');
    nav.className = 'tour-card-nav';
    nav.append(...right);
    footer.append(...left, nav);
    return footer;
  }

  private button(label: string, run: () => void, extra?: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    b.className = extra ? `tour-card-button ${extra}` : 'tour-card-button';
    b.textContent = label;
    // A click would otherwise move focus off the pane the next step's keys go to.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', run);
    return b;
  }
}
