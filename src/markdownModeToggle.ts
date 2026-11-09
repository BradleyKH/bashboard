export type MarkdownMode = 'preview' | 'raw';

/**
 * The Search preview's Raw / Preview button group for a markdown file, with the "View raw to edit"
 * hint after it while Preview is on (docs/design/files.md section 4.14). One instance per preview,
 * re-appended to each file's toolbar, so the choice holds while browsing results.
 */
export class MarkdownModeToggle {
  /** The button group and the hint, in toolbar order. */
  readonly els: readonly HTMLElement[];
  private readonly rawBtn: HTMLButtonElement;
  private readonly previewBtn: HTMLButtonElement;
  private readonly hint: HTMLSpanElement;
  private current: MarkdownMode = 'preview';

  constructor(private readonly onChange: (mode: MarkdownMode) => void) {
    const group = document.createElement('span');
    group.className = 'markdown-mode';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Markdown view');
    this.rawBtn = this.button('Raw', 'Show the markdown source, editable', 'raw');
    this.previewBtn = this.button('Preview', 'Show the rendered markdown', 'preview');
    group.append(this.rawBtn, this.previewBtn);
    this.hint = document.createElement('span');
    this.hint.className = 'markdown-mode-hint';
    this.hint.textContent = 'View raw to edit';
    this.els = [group, this.hint];
    this.sync();
  }

  get mode(): MarkdownMode {
    return this.current;
  }

  private button(label: string, title: string, mode: MarkdownMode): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', () => {
      if (this.current === mode) return;
      this.current = mode;
      this.sync();
      this.onChange(mode);
    });
    return btn;
  }

  private sync(): void {
    this.rawBtn.setAttribute('aria-pressed', String(this.current === 'raw'));
    this.previewBtn.setAttribute('aria-pressed', String(this.current === 'preview'));
    this.hint.hidden = this.current === 'raw';
  }
}
