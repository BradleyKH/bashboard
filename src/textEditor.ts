import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { Annotation, Compartment, EditorState as CmState, type Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap as cmKeymap, lineNumbers as cmLineNumbers } from '@codemirror/view';
import './code/syntax.css';
import { type CodeColorsMode, codeColorsDefault } from './code/codeColorsStore';
import { type LanguageId, loadLanguage } from './code/languages';
import { roleHighlighter } from './code/roles';
import { lookup, type Action, type Keymap } from './keymap';
import { toFontFamily } from './pane';
import type { FindSurface, TextFindSurface } from './previewFind';
import { findMatches, type FindMatches } from './previewFindModel';
import { classifyReadError, fsReadText, fsWriteText } from './repoFiles';
import type { Settings } from './settings';
import { editorStep, initialEditorState, type EditorEffect, type EditorEvent, type EditorState } from './textEditorModel';
import { textFieldOwns } from './textPaneKeys';

export interface TextEditorOptions {
  path: string;
  text: string;
  /** The file's modified time from the read that produced `text`. */
  modified: number;
  settings: Settings;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  /** Code: a line-number gutter, and long lines scroll sideways instead of wrapping. */
  lineNumbers?: boolean;
  /** The read was lossy (`FileText.lossy`); the editor opens read-only. */
  lossy?: boolean;
  /** A save reached the disk. */
  onSaved?: () => void;
  /** The language to color by; null (the default) leaves the text uncolored. */
  language?: LanguageId | null;
  /** Plain or Syntax; defaults to the mode a new pane starts in. */
  mode?: CodeColorsMode;
}

/** Marks a transaction the editor made itself (a reload), which is not an edit to save. */
const external = Annotation.define<boolean>();

const setBand = StateEffect.define<number | null>();

/** The line `revealLine` marked; dropped on the first edit. */
const bandField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setBand)) {
        if (e.value === null) return Decoration.none;
        const line = tr.state.doc.line(e.value);
        return Decoration.set([Decoration.line({ class: 'editor-band' }).range(line.from)]);
      }
    }
    if (tr.docChanged && !tr.annotation(external)) return Decoration.none;
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const setFind = StateEffect.define<{ ranges: readonly [number, number][]; current: number }>();
const findMark = Decoration.mark({ class: 'editor-find' });
const findCurrentMark = Decoration.mark({ class: 'editor-find editor-find-current' });

/** The find bar's matches, painted as marks since only the lines in view exist in the DOM. */
const findField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setFind)) {
        const { ranges, current } = e.value;
        return Decoration.set(ranges.map(([from, to], i) => (i === current ? findCurrentMark : findMark).range(from, to)));
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Only undo and redo: the rest of `historyKeymap` (Mod-u, Alt-u, Linux's Ctrl-Shift-z) stays unbound. */
const undoRedoKeys = historyKeymap.filter((b) => b.key === 'Mod-z' || b.key === 'Mod-y');

/** Enter inserts a bare newline, as the textarea did, rather than keeping the indent. */
const editorKeys = [{ key: 'Enter', run: insertNewline, shift: insertNewline }, ...standardKeymap, ...undoRedoKeys];

/** The look of the textarea it replaced: transparent, `--content-fg`, the pane's font. */
const editorTheme = EditorView.theme({
  '&': { flex: '1 1 auto', minWidth: '0', minHeight: '0', backgroundColor: 'transparent', color: 'var(--content-fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'normal', scrollbarGutter: 'stable' },
  '.cm-content': { padding: '4px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': {
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    color: 'var(--content-faint)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px' },
});

/** The monospaced editor for a file on disk (docs/design/files.md sections 4.12, Text editor, and 4.22). */
export class TextEditor {
  readonly el: HTMLElement;
  private readonly view: EditorView;
  private readonly field: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly error: HTMLElement;
  private readonly lossyNote: HTMLElement;
  private readonly opts: TextEditorOptions;
  private readonly readOnlyConf = new Compartment();
  private readonly languageConf = new Compartment();
  private language: LanguageId | null;
  private mode: CodeColorsMode;
  /** Bumped on every language or mode change, so a load that lands late is dropped. */
  private languageToken = 0;
  private state: EditorState;
  private timer: number | null = null;
  private pending: Promise<void> | null = null;
  private reading: Promise<void> | null = null;
  /** The file on disk uses CRLF; the document only ever holds LF. */
  private crlf: boolean;
  private readOnly = false;
  private surface: TextFindSurface | null = null;
  private readonly changeListeners = new Set<() => void>();
  private findRanges: [number, number][] = [];
  private disposed = false;

  constructor(opts: TextEditorOptions) {
    this.opts = opts;
    this.crlf = opts.text.includes('\r\n');
    this.state = initialEditorState(toLf(opts.text), opts.modified);
    this.language = opts.language ?? null;
    this.mode = opts.mode ?? codeColorsDefault();

    this.el = document.createElement('div');
    this.el.className = 'text-editor';

    this.bar = document.createElement('div');
    this.bar.className = 'editor-bar';
    this.bar.hidden = true;
    const barText = document.createElement('span');
    barText.className = 'editor-bar-text';
    barText.textContent = 'This file changed on disk.';
    const reload = this.barButton('Reload', 'Discard your edits and show the file on disk', () => void this.reloadFromDisk());
    const keep = this.barButton('Keep mine', 'Overwrite the file with your edits', () => void this.keepMine());
    this.bar.append(barText, reload, keep);

    this.error = document.createElement('div');
    this.error.className = 'editor-error';
    this.error.hidden = true;

    this.lossyNote = document.createElement('div');
    this.lossyNote.className = 'editor-note';
    this.lossyNote.textContent = 'Read-only: this file is not valid UTF-8, and saving it here would change its bytes.';

    this.field = document.createElement('div');
    this.field.className = 'editor-field';

    const extensions: Extension[] = [
      // Runs before CodeMirror's keymap, so app chords like Ctrl+Shift+Left win over its bindings.
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (e) => this.onKeyDown(e),
          blur: () => {
            this.send({ type: 'saveRequested' });
            return false;
          },
        }),
      ),
      history(),
      cmKeymap.of(editorKeys),
      CmState.tabSize.of(8),
      this.readOnlyConf.of(CmState.readOnly.of(false)),
      this.languageConf.of([]),
      bandField,
      findField,
      editorTheme,
      EditorView.contentAttributes.of({ spellcheck: 'false' }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (!u.transactions.some((tr) => tr.annotation(external))) {
          this.send({ type: 'edit', text: u.state.doc.toString() });
        }
        // A listener may search and repaint, which cannot dispatch inside this update.
        if (this.changeListeners.size > 0) queueMicrotask(() => this.changeListeners.forEach((fn) => fn()));
      }),
    ];
    if (opts.lineNumbers) extensions.push(cmLineNumbers());
    else extensions.push(EditorView.lineWrapping);

    this.view = new EditorView({
      parent: this.field,
      state: CmState.create({ doc: this.state.text, extensions }),
    });
    if (opts.lineNumbers) {
      // CodeMirror's gutter is sticky over the scrolled text, and its translucent background (the
      // backdrop shows through) would let that text show, so the text clips where it passes under.
      const scroller = this.view.scrollDOM;
      scroller.addEventListener('scroll', () => this.field.style.setProperty('--gutter-clip', `${scroller.scrollLeft}px`));
    }
    this.applySettings(opts.settings);

    this.el.append(this.bar, this.lossyNote, this.error, this.field);
    this.setLossy(opts.lossy ?? false);
    void this.applyLanguage();
  }

  get text(): string {
    return this.state.text;
  }

  /** The file's modified time as of the last read or save. */
  get modified(): number {
    return this.state.modified;
  }

  /** Whether the last read was lossy, which leaves the editor read-only. */
  get lossy(): boolean {
    return this.readOnly;
  }

  /** Whether the editor has a language to color by, which enables the Plain | Syntax toggle. */
  get hasColors(): boolean {
    return this.language !== null;
  }

  focus(): void {
    this.view.focus();
  }

  applySettings(settings: Settings): void {
    this.field.style.fontFamily = toFontFamily(settings.font.family);
    this.field.style.fontSize = `calc(${settings.font.size}px * var(--preview-zoom, 1))`;
    this.view.requestMeasure();
  }

  /** Colors by `id` in Syntax mode; null leaves the text uncolored. */
  setLanguage(id: LanguageId | null): void {
    if (id === this.language) return;
    this.language = id;
    void this.applyLanguage();
  }

  /** Plain or Syntax; keeps the caret, scroll position, selection, and undo history. */
  setMode(mode: CodeColorsMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    void this.applyLanguage();
  }

  /**
   * Scrolls the 1-based `line` to the middle, marks it, and puts the caret at its start without
   * taking focus.
   */
  revealLine(line: number): void {
    const doc = this.view.state.doc;
    const at = Math.min(Math.max(1, line), doc.lines);
    const from = doc.line(at).from;
    this.view.dispatch({
      selection: { anchor: from },
      effects: [setBand.of(at), EditorView.scrollIntoView(from, { y: 'center', x: 'start' })],
    });
  }

  /** Measures again after the text size changed (a zoom step). */
  relayout(): void {
    this.view.requestMeasure();
  }

  findSurface(): FindSurface {
    this.surface ??= {
      find: (query) => this.find(query),
      setCurrent: (index, reveal) => this.paintFind(index, reveal),
      clear: () => this.clearFind(),
      finish: (match) => this.finishFind(match),
      onChange: (listener) => {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
      },
    };
    return this.surface;
  }

  /** The folder watch saw this file's modified time change. */
  diskChanged(modified: number): void {
    this.send({ type: 'diskChanged', modified });
  }

  /** Saves pending edits and resolves once no save is in flight. */
  async flush(): Promise<void> {
    this.send({ type: 'saveRequested' });
    // Saves wait for a disk change check, so retry once it lands.
    while (this.reading) {
      await this.reading;
      this.send({ type: 'saveRequested' });
    }
    while (this.pending) await this.pending;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.changeListeners.clear();
    this.view.destroy();
    this.el.remove();
  }

  private async applyLanguage(): Promise<void> {
    const token = ++this.languageToken;
    const id = this.language;
    if (this.mode === 'plain' || id === null) {
      this.reconfigureLanguage([]);
      return;
    }
    let support: Extension;
    try {
      support = await loadLanguage(id);
    } catch (err) {
      console.error(`could not load the ${id} language`, err);
      return;
    }
    if (token !== this.languageToken || this.disposed) return;
    this.reconfigureLanguage([support, syntaxHighlighting(roleHighlighter)]);
  }

  private reconfigureLanguage(ext: Extension): void {
    if (this.disposed) return;
    this.view.dispatch({ effects: this.languageConf.reconfigure(ext) });
  }

  private find(query: string): FindMatches {
    const found = findMatches(this.view.state.doc.toString(), query);
    this.findRanges = found.ranges;
    this.view.dispatch({ effects: setFind.of({ ranges: found.ranges, current: -1 }) });
    return found;
  }

  private paintFind(index: number, reveal: boolean): void {
    const effects: StateEffect<unknown>[] = [setFind.of({ ranges: this.findRanges, current: index })];
    const match = this.findRanges[index];
    if (reveal && match) effects.push(EditorView.scrollIntoView(match[0], { y: 'nearest', yMargin: 40 }));
    this.view.dispatch({ effects });
  }

  private clearFind(): void {
    this.findRanges = [];
    if (!this.disposed) this.view.dispatch({ effects: setFind.of({ ranges: [], current: -1 }) });
  }

  /** Leaves the current match selected, as the caret's new place. */
  private finishFind(match: readonly [number, number] | null): void {
    this.clearFind();
    if (this.disposed) return;
    if (match) {
      const len = this.view.state.doc.length;
      this.view.dispatch({ selection: { anchor: Math.min(match[0], len), head: Math.min(match[1], len) } });
    }
    this.view.focus();
  }

  private send(event: EditorEvent): void {
    if (this.disposed) return;
    const step = editorStep(this.state, event);
    this.state = step.state;
    for (const effect of step.effects) this.run(effect);
    this.bar.hidden = !this.state.conflict;
  }

  private run(effect: EditorEffect): void {
    switch (effect.type) {
      case 'schedule':
        this.clearTimer();
        this.timer = window.setTimeout(() => {
          this.timer = null;
          this.send({ type: 'saveRequested' });
        }, effect.ms);
        break;
      case 'cancel':
        this.clearTimer();
        break;
      case 'save':
        this.save(effect.text, effect.expectedModified);
        break;
      case 'reload': {
        const read = this.reloadFromDisk().finally(() => {
          if (this.reading === read) this.reading = null;
        });
        this.reading = read;
        break;
      }
      case 'setText':
        this.replaceText(effect.text);
        this.showError(null);
        break;
    }
  }

  /** Swaps in `text` as one change over the part that differs, so the caret stays near its place. */
  private replaceText(text: string): void {
    const old = this.view.state.doc.toString();
    if (old === text) return;
    let start = 0;
    const max = Math.min(old.length, text.length);
    while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
    let end = 0;
    while (end < max - start && old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
    this.view.dispatch({
      changes: { from: start, to: old.length - end, insert: text.slice(start, text.length - end) },
      annotations: external.of(true),
    });
  }

  private save(text: string, expectedModified: number): void {
    const run: { done?: Promise<void> } = {};
    run.done = (async () => {
      try {
        const onDisk = this.crlf ? text.replace(/\n/g, '\r\n') : text;
        const modified = await fsWriteText(this.opts.path, onDisk, expectedModified);
        this.showError(null);
        this.send({ type: 'saved', modified });
        this.opts.onSaved?.();
      } catch (err) {
        const conflict = classifyReadError(err) === 'conflict';
        if (!conflict) this.showError(`Could not save: ${errorMessage(err)}`);
        this.send({ type: 'saveFailed', conflict });
      } finally {
        // A follow-up save started by the handlers above has already replaced `pending`.
        if (this.pending === run.done) this.pending = null;
      }
    })();
    this.pending = run.done;
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      const file = await fsReadText(this.opts.path);
      if (this.disposed) return;
      this.crlf = file.text.includes('\r\n');
      this.setLossy(file.lossy);
      this.send({ type: 'reloaded', text: toLf(file.text), modified: file.modified });
    } catch (err) {
      this.showError(`Could not reload: ${errorMessage(err)}`);
      this.send({ type: 'reloadFailed' });
    }
  }

  private async keepMine(): Promise<void> {
    try {
      const file = await fsReadText(this.opts.path);
      if (this.disposed) return;
      this.send({ type: 'keepMine', modified: file.modified });
    } catch (err) {
      this.showError(`Could not save: ${errorMessage(err)}`);
    }
  }

  private setLossy(lossy: boolean): void {
    this.lossyNote.hidden = !lossy;
    if (lossy === this.readOnly) return;
    this.readOnly = lossy;
    this.view.dispatch({ effects: this.readOnlyConf.reconfigure(CmState.readOnly.of(lossy)) });
  }

  private showError(message: string | null): void {
    this.error.hidden = message === null;
    this.error.textContent = message ?? '';
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** True when the key was handled here, which keeps it from CodeMirror's keymap. */
  private onKeyDown(e: KeyboardEvent): boolean {
    if (e.key.toLowerCase() === 's' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.send({ type: 'saveRequested' });
      return true;
    }
    const action = lookup(this.opts.keymap(), e);
    if (action && !textFieldOwns(action) && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    return false;
  }

  private barButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
}

/** The document holds LF only, so the model compares against that form. */
function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function errorMessage(err: unknown): string {
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  return text.replace(/^[a-zA-Z]+:\s*/, '');
}
