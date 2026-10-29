import { lookup, type Action, type Keymap } from './keymap';
import { toFontFamily } from './pane';
import { revealIn, type FindSurface } from './previewFind';
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
}

/** The monospaced editor for a file on disk (docs/design.md section 4.12, Text editor). */
export class TextEditor {
  readonly el: HTMLElement;
  private readonly area: HTMLTextAreaElement;
  private readonly field: HTMLElement;
  /**
   * A copy of the text laid out exactly under the transparent textarea, so the find bar can
   * highlight matches, which a textarea cannot show itself. Filled only while find is open.
   */
  private readonly mirror: HTMLElement;
  private mirrorOn = false;
  private readonly bar: HTMLElement;
  private readonly error: HTMLElement;
  private readonly opts: TextEditorOptions;
  private state: EditorState;
  private timer: number | null = null;
  private pending: Promise<void> | null = null;
  private reading: Promise<void> | null = null;
  /** The file on disk uses CRLF; the textarea only ever holds LF. */
  private crlf: boolean;
  private disposed = false;

  constructor(opts: TextEditorOptions) {
    this.opts = opts;
    this.crlf = opts.text.includes('\r\n');
    this.state = initialEditorState(toLf(opts.text), opts.modified);

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

    this.area = document.createElement('textarea');
    this.area.className = 'editor-text';
    this.area.spellcheck = false;
    this.area.value = this.state.text;
    this.mirror = document.createElement('div');
    this.mirror.className = 'editor-mirror';
    this.mirror.setAttribute('aria-hidden', 'true');
    this.field = document.createElement('div');
    this.field.className = 'editor-field';
    this.field.append(this.mirror, this.area);
    this.applySettings(opts.settings);

    this.el.append(this.bar, this.error, this.field);

    this.area.addEventListener('input', () => {
      this.syncMirror();
      this.send({ type: 'edit', text: this.area.value });
    });
    this.area.addEventListener('scroll', () => (this.mirror.scrollTop = this.area.scrollTop));
    this.area.addEventListener('blur', () => this.send({ type: 'saveRequested' }));
    this.area.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  get text(): string {
    return this.state.text;
  }

  /** The file's modified time as of the last read or save. */
  get modified(): number {
    return this.state.modified;
  }

  focus(): void {
    this.area.focus();
  }

  applySettings(settings: Settings): void {
    this.field.style.fontFamily = toFontFamily(settings.font.family);
    this.field.style.fontSize = `calc(${settings.font.size}px * var(--preview-zoom, 1))`;
  }

  findSurface(): FindSurface {
    if (!this.mirrorOn) {
      this.mirrorOn = true;
      this.syncMirror();
    }
    return {
      textRoot: this.mirror,
      // The mirror sits exactly under the textarea, so its ranges measure the textarea's text.
      reveal: (range) => revealIn(this.area, range),
      done: (range) => this.findDone(range),
    };
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
    this.el.remove();
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
        if (this.area.value !== effect.text) {
          this.area.value = effect.text;
          this.syncMirror();
        }
        this.showError(null);
        break;
    }
  }

  private save(text: string, expectedModified: number): void {
    const run: { done?: Promise<void> } = {};
    run.done = (async () => {
      try {
        const onDisk = this.crlf ? text.replace(/\n/g, '\r\n') : text;
        const modified = await fsWriteText(this.opts.path, onDisk, expectedModified);
        this.showError(null);
        this.send({ type: 'saved', modified });
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

  private syncMirror(): void {
    if (!this.mirrorOn) return;
    this.mirror.textContent = this.area.value;
    this.mirror.scrollTop = this.area.scrollTop;
  }

  /** Leaves the current match selected in the textarea, as the caret's new place. */
  private findDone(range: Range | null): void {
    // The mirror holds one text node, so range offsets are textarea offsets.
    const start = range?.startOffset;
    const end = range?.endOffset;
    this.mirrorOn = false;
    this.mirror.textContent = '';
    this.area.focus({ preventScroll: true });
    if (start !== undefined && end !== undefined) this.area.setSelectionRange(start, end);
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

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key.toLowerCase() === 's' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.send({ type: 'saveRequested' });
      return;
    }
    const action = lookup(this.opts.keymap(), e);
    if (action && !textFieldOwns(action) && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
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

/** A textarea's value normalizes line breaks to LF, so the model compares against that form. */
function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function errorMessage(err: unknown): string {
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  return text.replace(/^[a-zA-Z]+:\s*/, '');
}
