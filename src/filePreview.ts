import './filePreview.css';
import { BinaryNotice } from './binaryNotice';
import { CodeView } from './codeView';
import { previewKind } from './filesModel';
import type { Action, Keymap } from './keymap';
import { MarkdownView } from './markdownView';
import { PreviewFind } from './previewFind';
import { classifyReadError, fsReadText } from './repoFiles';
import type { Settings } from './settings';
import { TextEditor } from './textEditor';
import { ZoomButtons } from './zoomButtons';

export interface FilePreviewOptions {
  host: HTMLElement;
  settings: Settings;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  /** A markdown link to another file; `path` is absolute. */
  onOpenFile: (path: string) => void;
  onOpenInEditor: (path: string) => void;
}

type Current =
  | { kind: 'markdown'; path: string; view: MarkdownView }
  | { kind: 'plain'; path: string; view: TextEditor; find: PreviewFind }
  | { kind: 'code'; path: string; view: CodeView; modified: number; find: PreviewFind }
  | { kind: 'notice'; path: string; view: BinaryNotice };

/** The right half of a Files pane: shows the selected file (docs/design.md section 4.12). */
export class FilePreview {
  readonly el: HTMLElement;
  private readonly opts: FilePreviewOptions;
  /** Kept across files, so the zoom holds while browsing. */
  private readonly zoom: ZoomButtons;
  private settings: Settings;
  private current: Current | null = null;
  private generation = 0;

  constructor(opts: FilePreviewOptions) {
    this.opts = opts;
    this.settings = opts.settings;
    this.el = document.createElement('div');
    this.el.className = 'file-preview';
    this.zoom = new ZoomButtons('', 'filePreview', opts.settings.textZoom.filePreview, (zoom) =>
      this.el.style.setProperty('--preview-zoom', String(zoom)),
    );
    opts.host.appendChild(this.el);
    this.showEmpty();
  }

  /** The path being previewed, or null. */
  get path(): string | null {
    return this.current?.path ?? null;
  }

  /**
   * Shows a file, or clears the preview for null. `size` (from the listing) lets a file over
   * the text cap skip the read. Pending edits in the previous file are saved first.
   */
  async show(path: string | null, size = 0): Promise<void> {
    const gen = ++this.generation;
    await this.flush();
    if (gen !== this.generation) return;
    this.clear();
    if (path === null) {
      this.showEmpty();
      return;
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    const kind = previewKind(name, size);
    if (kind === 'binary') {
      this.setNotice(path, name, size, 'Too large to preview.');
      return;
    }
    try {
      const file = await fsReadText(path);
      if (gen !== this.generation) return;
      this.mount(path, kind, file.text, file.modified);
    } catch (err) {
      if (gen !== this.generation) return;
      const failure = classifyReadError(err);
      if (failure === 'binary') this.setNotice(path, name, size, 'Binary file.');
      else if (failure === 'tooLarge') this.setNotice(path, name, size, 'Too large to preview.');
      else this.setError(err);
    }
  }

  /** The folder watch saw the selected entry's modified time change. */
  diskChanged(modified: number): void {
    const c = this.current;
    if (!c) return;
    if (c.kind === 'markdown') void c.view.diskChanged(modified);
    else if (c.kind === 'plain') c.view.diskChanged(modified);
    else if (c.kind === 'code' && modified !== c.modified) {
      fsReadText(c.path).then(
        (file) => {
          if (this.current !== c) return;
          c.modified = file.modified;
          c.view.setText(file.text);
        },
        () => {},
      );
    }
  }

  focus(): void {
    const c = this.current;
    if (c?.kind === 'plain' || c?.kind === 'markdown') c.view.focus();
  }

  /** Opens the find bar on a text preview; false when the preview has none. */
  openFind(): boolean {
    const c = this.current;
    if (!c || c.kind === 'notice') return false;
    (c.kind === 'markdown' ? c.view.find : c.find).open();
    return true;
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    const c = this.current;
    if (c && c.kind !== 'notice') c.view.applySettings(settings);
  }

  /** Saves pending edits; resolves once nothing is in flight. */
  async flush(): Promise<void> {
    const c = this.current;
    if (c?.kind === 'markdown' || c?.kind === 'plain') await c.view.flush();
  }

  dispose(): void {
    this.generation++;
    this.clear();
    this.el.remove();
  }

  private mount(path: string, kind: 'markdown' | 'plain' | 'code', text: string, modified: number): void {
    const { keymap, dispatch } = this.opts;
    if (kind === 'markdown') {
      const view = new MarkdownView({
        path,
        text,
        modified,
        settings: this.settings,
        keymap,
        dispatch,
        onOpenFile: this.opts.onOpenFile,
      });
      view.toolbar.append(this.zoom.el);
      this.current = { kind, path, view };
      this.el.replaceChildren(view.el);
    } else if (kind === 'plain') {
      const view = new TextEditor({ path, text, modified, settings: this.settings, keymap, dispatch });
      const find = new PreviewFind(() => view.findSurface());
      this.current = { kind, path, view, find };
      this.el.replaceChildren(framed(view.el, find, this.zoom.el));
    } else {
      const view = new CodeView(text, this.settings);
      const find = new PreviewFind(() => view.findSurface());
      this.current = { kind, path, view, modified, find };
      this.el.replaceChildren(framed(view.el, find, this.zoom.el));
    }
  }

  private setNotice(path: string, name: string, size: number, reason: string): void {
    const view = new BinaryNotice(name, size, reason, () => this.opts.onOpenInEditor(path));
    this.current = { kind: 'notice', path, view };
    this.el.replaceChildren(view.el);
  }

  private setError(err: unknown): void {
    const div = document.createElement('div');
    div.className = 'preview-empty preview-error';
    const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    div.textContent = `Could not read the file: ${text}`;
    this.el.replaceChildren(div);
  }

  private showEmpty(): void {
    const div = document.createElement('div');
    div.className = 'preview-empty';
    div.textContent = 'Select a file to preview it.';
    this.el.replaceChildren(div);
  }

  private clear(): void {
    const c = this.current;
    if (c?.kind === 'plain' || c?.kind === 'code') c.find.dispose();
    c?.view.dispose();
    this.current = null;
    this.el.replaceChildren();
  }
}

/** A view under a toolbar holding its find button and bar, then the zoom buttons. */
function framed(view: HTMLElement, find: PreviewFind, zoom: HTMLElement): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'preview-frame';
  const toolbar = document.createElement('div');
  toolbar.className = 'preview-toolbar';
  toolbar.append(find.button, find.bar, zoom);
  frame.append(toolbar, view);
  return frame;
}
