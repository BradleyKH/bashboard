import { parseLineTarget, type LineTarget } from './goToLineModel';

/** What the Go to line bar needs from the code view it moves. */
export interface GoToLineSurface {
  lineCount(): number;
  /** Scrolls to and marks the line without taking focus. */
  reveal(target: LineTarget): void;
  /** The bar closed; takes focus back. */
  done(): void;
}

/**
 * The Go to line bar on a code preview's toolbar (docs/design/files.md section 4.12). The view
 * follows the typed line as it changes; Enter or Esc closes the bar and returns focus to the
 * editor, whose caret is then on that line.
 */
export class GoToLine {
  readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly surface: GoToLineSurface;

  constructor(surface: GoToLineSurface) {
    this.surface = surface;
    this.bar = document.createElement('div');
    // Shares the find bar's layout and input styling (filePreview.css).
    this.bar.className = 'preview-find preview-goto';
    this.bar.hidden = true;
    const label = document.createElement('span');
    label.className = 'find-count';
    label.textContent = 'Line';
    this.input = document.createElement('input');
    this.input.className = 'find-input';
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.title = 'A line, or line:column; Enter to go, Esc to close';
    this.bar.append(label, this.input);
    this.input.addEventListener('input', () => {
      const target = parseLineTarget(this.input.value);
      if (target) this.surface.reveal(target);
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    // Clicking away leaves the bar open but stale; closing keeps the toolbar tidy.
    this.input.addEventListener('blur', () => this.hide());
  }

  get isOpen(): boolean {
    return !this.bar.hidden;
  }

  /** Shows the bar, or refocuses and selects its input if already open. */
  open(): void {
    this.bar.hidden = false;
    this.input.placeholder = `1 to ${this.surface.lineCount()}`;
    this.input.focus();
    this.input.select();
  }

  dispose(): void {
    this.bar.remove();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing) return;
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    // Stops here so Esc does not also send a Search preview back to its results list.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Enter') {
      const target = parseLineTarget(this.input.value);
      if (target) this.surface.reveal(target);
    }
    this.hide();
    this.surface.done();
  }

  private hide(): void {
    this.bar.hidden = true;
    this.input.value = '';
  }
}
