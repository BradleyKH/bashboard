import type { GitDiff } from './gitApi';
import { diffLines } from './gitModel';

/** The unified diff panel beside the Git pane's lists (docs/design.md section 4.13). */
export class GitDiffView {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly undoError: HTMLElement;
  private readonly note: HTMLElement;
  private readonly body: HTMLElement;

  /** `onUndo` is the Undo commit button in the bar above a commit's diff. */
  constructor(onUndo: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'git-diff';
    this.bar = document.createElement('div');
    this.bar.className = 'git-diff-bar';
    this.bar.hidden = true;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'git-row-btn git-undo';
    undo.textContent = 'Undo commit';
    undo.addEventListener('click', onUndo);
    this.undoError = document.createElement('span');
    this.undoError.className = 'git-undo-error';
    this.bar.append(undo, this.undoError);
    this.note = document.createElement('div');
    this.note.className = 'git-diff-note';
    this.note.textContent = 'Diff truncated at 1 MiB';
    this.note.hidden = true;
    this.body = document.createElement('div');
    this.body.className = 'git-diff-body';
    this.el.append(this.bar, this.note, this.body);
    this.clear();
  }

  /** Renders a diff; `truncated` shows the cap note above it. */
  show(diff: GitDiff): void {
    const lines = diffLines(diff.text);
    this.note.hidden = !diff.truncated;
    if (lines.length === 0) {
      this.placeholder('No changes to show');
      return;
    }
    this.body.replaceChildren(
      ...lines.map((l) => {
        const row = document.createElement('div');
        row.className = `git-diff-line ${l.kind}`;
        row.textContent = l.text === '' ? ' ' : l.text;
        return row;
      }),
    );
    this.body.scrollTop = 0;
  }

  /** Shows the bar with Undo commit, and an inline refusal (3.9) beside it when `error` is set. */
  setUndo(shown: boolean, error: string | null = null): void {
    this.bar.hidden = !shown;
    this.undoError.textContent = error ?? '';
  }

  /** Nothing selected. */
  clear(): void {
    this.note.hidden = true;
    this.placeholder('Select a file or commit to see its diff');
  }

  /** A failed diff fetch, shown in place of the diff. */
  showError(text: string): void {
    this.note.hidden = true;
    this.placeholder(text);
  }

  private placeholder(text: string): void {
    const p = document.createElement('div');
    p.className = 'git-diff-placeholder';
    p.textContent = text;
    this.body.replaceChildren(p);
  }
}
