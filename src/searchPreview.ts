import './filePreview.css';
import { BinaryNotice } from './binaryNotice';
import { toFontFamily } from './pane';
import { classifyReadError, fsReadText } from './repoFiles';
import type { Settings } from './settings';
import { textZoom } from './textZoomStore';
import { ZoomButtons } from './zoomButtons';

export interface SearchPreviewOptions {
  settings: Settings;
  onOpenInEditor: (path: string, line: number | null) => void;
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The right half of a Search pane: one file, read-only, with line numbers, scrolled to the
 * selected line (docs/design.md section 4.14). The text goes in as one `textContent` per column
 * and the selected line is an overlay band, so a large file costs one layout, not one row each.
 */
export class SearchPreview {
  readonly el: HTMLElement;
  /** Below the zoom bar; the file, a notice, or a message. */
  private readonly content: HTMLElement;
  private readonly opts: SearchPreviewOptions;
  private settings: Settings;
  private view: HTMLElement | null = null;
  private code: HTMLElement | null = null;
  private band: HTMLElement | null = null;
  /** The file on screen, kept so stepping through one file's matches does not re-read it. */
  private loadedPath: string | null = null;
  private lineCount = 0;
  /** The highlighted line, kept so a zoom step can move the band with the text. */
  private line: number | null = null;
  private notice: BinaryNotice | null = null;
  /** Bumped per `show`, so a late read for an older selection is dropped. */
  private generation = 0;

  constructor(opts: SearchPreviewOptions) {
    this.opts = opts;
    this.settings = opts.settings;
    this.el = document.createElement('div');
    this.el.className = 'search-preview';
    const bar = document.createElement('div');
    bar.className = 'preview-toolbar search-preview-bar';
    this.content = document.createElement('div');
    this.content.className = 'search-preview-content';
    const zoom = new ZoomButtons(
      '',
      'searchPreview',
      textZoom('searchPreview'),
      (z) => {
        this.el.style.setProperty('--search-zoom', String(z));
        this.placeBand();
      },
      this.el,
    );
    bar.append(zoom.el);
    this.el.append(bar, this.content);
    this.showMessage('Select a result to preview its file.');
  }

  /** Shows `path` (absolute), highlighting the 1-based `line`; null clears the preview. */
  async show(path: string | null, line: number | null = null): Promise<void> {
    const gen = ++this.generation;
    if (path === null) {
      this.reset();
      this.showMessage('Select a result to preview its file.');
      return;
    }
    if (path !== this.loadedPath) {
      let text: string;
      try {
        text = (await fsReadText(path)).text;
      } catch (err) {
        if (gen !== this.generation) return;
        this.reset();
        const kind = classifyReadError(err);
        const name = path.split(/[\\/]/).pop() ?? path;
        if (kind === 'binary' || kind === 'tooLarge') {
          this.notice = new BinaryNotice(
            name,
            0,
            kind === 'binary' ? 'Binary file.' : 'Too large to preview.',
            () => this.opts.onOpenInEditor(path, line),
          );
          this.content.replaceChildren(this.notice.el);
        } else {
          this.showMessage(`Could not read the file: ${errorText(err)}`, true);
        }
        return;
      }
      if (gen !== this.generation) return;
      this.mount(path, text);
    }
    this.highlight(line);
  }

  /** Drops the cached file, so the next `show` re-reads it (a new search may follow edits). */
  invalidate(): void {
    this.loadedPath = null;
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    if (this.view) this.applyFont(this.view);
  }

  dispose(): void {
    this.generation++;
    this.reset();
    this.el.remove();
  }

  private mount(path: string, text: string): void {
    this.reset();
    const lines = text.split(/\r?\n/);
    // A trailing newline ends the last line rather than starting another.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const view = document.createElement('div');
    view.className = 'search-code';
    const gutter = document.createElement('pre');
    gutter.className = 'search-code-gutter';
    gutter.textContent = lines.map((_, i) => String(i + 1)).join('\n');
    const code = document.createElement('pre');
    code.className = 'search-code-text';
    code.textContent = lines.join('\n');
    const band = document.createElement('div');
    band.className = 'search-code-band';
    band.hidden = true;
    view.append(band, gutter, code);
    this.applyFont(view);
    this.content.replaceChildren(view);
    this.view = view;
    this.code = code;
    this.band = band;
    this.loadedPath = path;
    this.lineCount = lines.length;
  }

  private highlight(line: number | null): void {
    this.line = line;
    const view = this.view;
    if (!view) return;
    const placed = this.placeBand();
    view.scrollTop = placed ? Math.max(0, placed.top - (view.clientHeight - placed.lineHeight) / 2) : 0;
  }

  /** Puts the band over the highlighted line at the current zoom; null when there is none. */
  private placeBand(): { top: number; lineHeight: number } | null {
    const { view, code, band, line } = this;
    if (!view || !code || !band) return null;
    if (line === null || line < 1 || line > this.lineCount) {
      band.hidden = true;
      return null;
    }
    const style = getComputedStyle(code);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    const top = code.offsetTop + (parseFloat(style.paddingTop) || 0) + (line - 1) * lineHeight;
    band.style.top = `${top}px`;
    band.style.height = `${lineHeight}px`;
    band.hidden = true;
    // Measured with the band hidden, so its old width does not hold the scroll width open.
    band.style.width = `${view.scrollWidth}px`;
    band.hidden = false;
    return { top, lineHeight };
  }

  private applyFont(view: HTMLElement): void {
    view.style.fontFamily = toFontFamily(this.settings.font.family);
    view.style.fontSize = `calc(${this.settings.font.size}px * var(--search-zoom, 1))`;
  }

  private showMessage(text: string, error = false): void {
    const div = document.createElement('div');
    div.className = error ? 'preview-empty preview-error' : 'preview-empty';
    div.textContent = text;
    this.content.replaceChildren(div);
  }

  private reset(): void {
    this.notice?.dispose();
    this.notice = null;
    this.view = null;
    this.code = null;
    this.band = null;
    this.loadedPath = null;
    this.lineCount = 0;
    this.line = null;
    this.content.replaceChildren();
  }
}
