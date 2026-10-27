export interface GitCommitBoxOptions {
  /** Ctrl+Enter in the field, or the Commit button while enabled. */
  onCommit: (message: string) => void;
  /** The message text changed by typing; the caller recomputes `canCommit` and calls `setEnabled`. */
  onInput: (message: string) => void;
}

/** Commit message field and button (docs/design.md section 4.13). */
export class GitCommitBox {
  readonly el: HTMLElement;
  private readonly field: HTMLTextAreaElement;
  private readonly button: HTMLButtonElement;
  private readonly error: HTMLElement;
  private enabled = false;

  constructor(private readonly opts: GitCommitBoxOptions) {
    this.el = document.createElement('div');
    this.el.className = 'git-commit';

    this.field = document.createElement('textarea');
    this.field.className = 'git-commit-field';
    this.field.rows = 3;
    this.field.placeholder = 'Commit message (Ctrl+Enter to commit)';
    this.field.spellcheck = false;
    this.field.addEventListener('input', () => this.opts.onInput(this.field.value));
    this.field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        // Ctrl+Enter is not a keymap action; keep the pane's key routing from seeing it.
        e.preventDefault();
        e.stopPropagation();
        this.commit();
      }
    });

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'git-commit-btn';
    this.button.textContent = 'Commit';
    this.button.disabled = true;
    this.button.addEventListener('click', () => this.commit());

    this.error = document.createElement('pre');
    this.error.className = 'git-commit-error';
    this.error.hidden = true;

    this.el.append(this.field, this.button, this.error);
  }

  focus(): void {
    this.field.focus();
  }

  message(): string {
    return this.field.value;
  }

  /** Sets the text without firing `onInput` (the undo path); the caller updates `setEnabled`. */
  setMessage(text: string): void {
    this.field.value = text;
    this.showError(null);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.button.disabled = !enabled;
  }

  /** Git's output under the box, the message kept; null hides it. */
  showError(output: string | null): void {
    this.error.textContent = output ?? '';
    this.error.hidden = !output;
  }

  /** After a successful commit: empties the field and hides any error. */
  clear(): void {
    this.field.value = '';
    this.showError(null);
    this.setEnabled(false);
  }

  private commit(): void {
    if (!this.enabled) return;
    this.opts.onCommit(this.field.value);
  }
}
