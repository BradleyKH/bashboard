import { delimiterFor, MAX_TABLE_ROWS, parseCsv } from './csvModel';
import type { Action, Keymap } from './keymap';
import { PreviewFind, revealIn, selectRange, type FindSurface } from './previewFind';
import { fsReadText } from './repoFiles';
import type { Settings } from './settings';
import { TextEditor } from './textEditor';

export interface CsvViewOptions {
  path: string;
  text: string;
  modified: number;
  lossy: boolean;
  settings: Settings;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onSaved?: () => void;
}

/** A CSV or TSV file as a table, with an Edit toggle to the text editor (docs/design/files.md section 4.12). */
export class CsvView {
  readonly el: HTMLElement;
  readonly find: PreviewFind;
  /** Where the owner adds its own controls, after Edit and Find. */
  readonly toolbar: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly opts: CsvViewOptions;
  private text: string;
  private modified: number;
  private lossy: boolean;
  private editor: TextEditor | null = null;
  private settings: Settings;
  private disposed = false;

  constructor(opts: CsvViewOptions) {
    this.opts = opts;
    this.text = opts.text;
    this.modified = opts.modified;
    this.lossy = opts.lossy;
    this.settings = opts.settings;

    this.el = document.createElement('div');
    this.el.className = 'csv-view';
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'preview-toolbar';
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.addEventListener('click', () => void this.toggleEdit());
    this.find = new PreviewFind(() => this.findSurface());
    this.toolbar.append(this.toggle, this.find.button, this.find.bar);
    this.body = document.createElement('div');
    this.body.className = 'csv-body';
    this.body.tabIndex = -1;
    this.el.append(this.toolbar, this.body);
    this.showTable();
  }

  focus(): void {
    if (this.editor) this.editor.focus();
    else this.body.focus();
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.editor?.applySettings(settings);
  }

  /** Lays out the editor's gutter again after a zoom change. */
  relayout(): void {
    this.editor?.relayout();
  }

  /** The folder watch saw this file's modified time change. */
  async diskChanged(modified: number): Promise<void> {
    if (this.editor) {
      this.editor.diskChanged(modified);
      return;
    }
    if (modified === this.modified) return;
    try {
      const file = await fsReadText(this.opts.path);
      if (this.disposed || this.editor) return;
      this.text = file.text;
      this.modified = file.modified;
      this.lossy = file.lossy;
      this.renderTable();
    } catch {
      // The file vanished or became unreadable; the pane's next listing clears the preview.
    }
  }

  async flush(): Promise<void> {
    await this.editor?.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.find.dispose();
    this.editor?.dispose();
    this.el.remove();
  }

  private async toggleEdit(): Promise<void> {
    if (this.editor) {
      await this.editor.flush();
      this.text = this.editor.text;
      this.modified = this.editor.modified;
      this.lossy = this.editor.lossy;
      this.editor.dispose();
      this.editor = null;
      this.showTable();
      this.find.refresh();
      return;
    }
    this.editor = new TextEditor({
      path: this.opts.path,
      text: this.text,
      modified: this.modified,
      lossy: this.lossy,
      settings: this.settings,
      keymap: this.opts.keymap,
      dispatch: this.opts.dispatch,
      lineNumbers: true,
      onSaved: this.opts.onSaved,
    });
    this.body.replaceChildren(this.editor.el);
    this.body.classList.add('editing');
    this.toggle.textContent = 'Done';
    this.toggle.title = 'Show the table';
    this.find.refresh();
    if (!this.find.isOpen) this.editor.focus();
  }

  private findSurface(): FindSurface {
    if (this.editor) return this.editor.findSurface();
    return {
      textRoot: this.body,
      reveal: (range) => revealIn(this.body, range),
      done: (range) => {
        this.body.focus({ preventScroll: true });
        selectRange(range);
      },
    };
  }

  private showTable(): void {
    this.body.classList.remove('editing');
    this.toggle.textContent = 'Edit';
    this.toggle.title = 'Edit this file as text';
    this.renderTable();
  }

  private renderTable(): void {
    const { rows, totalRows } = parseCsv(this.text, delimiterFor(this.opts.path));
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'preview-empty';
      empty.textContent = 'Empty file.';
      this.body.replaceChildren(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'csv-table';
    const head = table.createTHead().insertRow();
    for (const cell of rows[0]) {
      const th = document.createElement('th');
      th.textContent = cell;
      head.appendChild(th);
    }
    const tbody = table.createTBody();
    for (let r = 1; r < rows.length; r++) {
      const tr = tbody.insertRow();
      for (const cell of rows[r]) tr.insertCell().textContent = cell;
    }
    const parts: HTMLElement[] = [table];
    if (totalRows > rows.length) {
      const note = document.createElement('div');
      note.className = 'csv-note';
      note.textContent = `Showing the first ${MAX_TABLE_ROWS.toLocaleString()} of ${totalRows.toLocaleString()} rows. Edit shows the whole file.`;
      parts.push(note);
    }
    this.body.replaceChildren(...parts);
  }
}
