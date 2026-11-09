import type { GitDiff } from './gitApi';
import type { CodeColorsMode } from './code/codeColorsStore';
import { CodeColorsToggle } from './code/codeColorsToggle';
import { buildDiffColorModel, type DiffColorModel } from './code/diffColorModel';
import { renderLine, tokenize, type Token } from './code/highlightStatic';
import { languageIdFor } from './code/languages';
import { diffLines, type DiffLine } from './gitModel';
import { ZoomButtons } from './zoomButtons';

/** Rows recolored per task, so one large file does not hold the UI for its whole run. */
const COLOR_CHUNK = 400;

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

/** What the body currently shows, to tell a status-refresh re-fetch of the same diff from a new one. */
interface Shown {
  text: string;
  truncated: boolean;
  path: string | undefined;
}

/** The unified diff panel beside the Git pane's lists (docs/design/git.md section 4.13). */
export class GitDiffView {
  readonly el: HTMLElement;
  private readonly undo: HTMLButtonElement;
  private readonly undoError: HTMLElement;
  private readonly note: HTMLElement;
  private readonly body: HTMLElement;
  private readonly toggle: CodeColorsToggle;
  private mode: CodeColorsMode;
  private shown: Shown | null = null;
  private lines: DiffLine[] = [];
  private rowEls: HTMLElement[] = [];
  private model: DiffColorModel | null = null;
  /** Bumped by every show, clear, showError, and mode change, so a stale coloring run stops writing. */
  private gen = 0;

  /**
   * `onUndo` is the Undo commit button in the bar above a commit's diff; `zoom` is the starting zoom;
   * `codeColors` the starting mode, and `onCodeColors` hears a change made with the toggle.
   */
  constructor(
    onUndo: () => void,
    zoom: number,
    codeColors: CodeColorsMode,
    onCodeColors: (mode: CodeColorsMode) => void,
  ) {
    this.mode = codeColors;
    this.el = document.createElement('div');
    this.el.className = 'git-diff';
    const bar = document.createElement('div');
    bar.className = 'git-diff-bar';
    this.undo = document.createElement('button');
    this.undo.type = 'button';
    this.undo.className = 'git-row-btn git-undo';
    this.undo.textContent = 'Undo commit';
    this.undo.hidden = true;
    this.undo.addEventListener('click', onUndo);
    this.undoError = document.createElement('span');
    this.undoError.className = 'git-undo-error';
    this.toggle = new CodeColorsToggle((mode) => {
      this.mode = mode;
      onCodeColors(mode);
      this.rerender();
    });
    this.toggle.set(codeColors);
    const zoomButtons = new ZoomButtons('git-row-btn', 'gitDiff', zoom, (z) =>
      this.el.style.setProperty('--diff-zoom', String(z)),
      this.el,
    );
    bar.append(this.undo, this.undoError, this.toggle.el, zoomButtons.el);
    this.note = document.createElement('div');
    this.note.className = 'git-diff-note';
    this.note.textContent = 'Diff truncated at 1 MiB';
    this.note.hidden = true;
    this.body = document.createElement('div');
    this.body.className = 'git-diff-body';
    this.el.append(bar, this.note, this.body);
    this.clear();
  }

  /**
   * Renders a diff; `truncated` shows the cap note above it. `path` is the file the diff is for,
   * when the caller knows it, and names the language of a diff text that has no file header.
   * Showing the diff already on screen changes nothing, so a status refresh does not repaint.
   */
  show(diff: GitDiff, path?: string): void {
    const s = this.shown;
    if (s && s.text === diff.text && s.truncated === diff.truncated && s.path === path) return;
    this.shown = { text: diff.text, truncated: diff.truncated, path };
    this.note.hidden = !diff.truncated;
    this.lines = diffLines(diff.text);
    if (this.lines.length === 0) {
      this.gen++;
      this.model = null;
      this.toggle.setAvailable(false);
      this.placeholder('No changes to show');
      return;
    }
    this.model = buildDiffColorModel(diff.text, path);
    this.toggle.setAvailable(this.model.files.some((f) => languageIdFor(f.path) !== null));
    this.renderPlain();
    this.body.scrollTop = 0;
    this.startColoring();
  }

  /** Shows Undo commit, and an inline refusal (3.9) beside it when `error` is set. */
  setUndo(shown: boolean, error: string | null = null): void {
    this.undo.hidden = !shown;
    this.undoError.textContent = shown ? (error ?? '') : '';
  }

  /** Nothing selected. */
  clear(): void {
    this.reset();
    this.placeholder('Select a file or commit to see its diff');
  }

  /** A failed diff fetch, shown in place of the diff. */
  showError(text: string): void {
    this.reset();
    this.placeholder(text);
  }

  private reset(): void {
    this.gen++;
    this.shown = null;
    this.model = null;
    this.lines = [];
    this.note.hidden = true;
    this.toggle.setAvailable(false);
  }

  private placeholder(text: string): void {
    this.rowEls = [];
    const p = document.createElement('div');
    p.className = 'git-diff-placeholder';
    p.textContent = text;
    this.body.replaceChildren(p);
  }

  private renderPlain(): void {
    this.rowEls = this.lines.map((l) => {
      const row = document.createElement('div');
      row.className = `git-diff-line ${l.kind}`;
      row.textContent = l.text === '' ? ' ' : l.text;
      return row;
    });
    this.body.replaceChildren(...this.rowEls);
  }

  /** The toggle flipped: repaint the shown diff in the new mode, keeping the scroll position. */
  private rerender(): void {
    if (this.lines.length === 0 || this.model === null) return;
    const top = this.body.scrollTop;
    this.renderPlain();
    this.body.scrollTop = top;
    this.startColoring();
  }

  private startColoring(): void {
    const gen = ++this.gen;
    if (this.mode !== 'syntax' || this.model === null) return;
    // A language that fails to load leaves its rows plain; there is nothing else to undo.
    void this.colorize(this.model, gen).catch(() => undefined);
  }

  /**
   * Colors the rows file by file, in place: the row's prefix stays a text node under the row's
   * add or remove tint and only the code after it is split into token spans.
   */
  private async colorize(model: DiffColorModel, gen: number): Promise<void> {
    const byFile = model.files.map(() => [] as number[]);
    model.rows.forEach((ref, i) => {
      if (ref) byFile[ref.file].push(i);
    });
    for (let f = 0; f < model.files.length; f++) {
      const file = model.files[f];
      const language = languageIdFor(file.path);
      if (language === null || byFile[f].length === 0) continue;
      const tokens: Partial<Record<'new' | 'old', Token[][]>> = {};
      for (const side of ['new', 'old'] as const) {
        if (!byFile[f].some((i) => model.rows[i]?.side === side)) continue;
        // Yield first so a diff of many files lets the UI breathe between parses.
        await nextTask();
        if (gen !== this.gen) return;
        try {
          tokens[side] = await tokenize(side === 'new' ? file.newText : file.oldText, language);
        } catch {
          continue;
        }
        if (gen !== this.gen) return;
      }
      for (let k = 0; k < byFile[f].length; k++) {
        if (k > 0 && k % COLOR_CHUNK === 0) {
          await nextTask();
          if (gen !== this.gen) return;
        }
        const i = byFile[f][k];
        const ref = model.rows[i];
        const row = this.rowEls[i];
        const text = this.lines[i].text;
        const side = ref ? tokens[ref.side] : undefined;
        if (!ref || !side || !row || text === '') continue;
        const code = document.createElement('span');
        code.className = 'git-diff-code';
        renderLine(code, text.slice(1), side[ref.line] ?? []);
        row.replaceChildren(document.createTextNode(text.slice(0, 1)), code);
      }
    }
  }
}
