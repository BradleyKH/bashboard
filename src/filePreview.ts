import './filePreview.css';
import { BinaryNotice } from './binaryNotice';
import { CsvView } from './csvView';
import { canOpenWithDefaultApp, openWithDefaultApp } from './editors';
import { ExpandPreviewButton } from './expandPreviewButton';
import { previewKind } from './filesModel';
import { ImageView } from './imageView';
import type { Action, Keymap } from './keymap';
import { samePath } from './markdownRender';
import { MarkdownView } from './markdownView';
import { PreviewFind } from './previewFind';
import { classifyReadError, fsReadText, type FileText } from './repoFiles';
import type { Settings } from './settings';
import { TextEditor } from './textEditor';
import { textZoom, type TextZoomKey } from './textZoomStore';
import { ZoomButtons } from './zoomButtons';

export interface FilePreviewOptions {
  host: HTMLElement;
  settings: Settings;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  /** A markdown link to another file; `path` is absolute. */
  onOpenFile: (path: string) => void;
  onOpenInEditor: (path: string) => void;
  /** The expand button was clicked; without it the preview has no expand button. */
  onToggleExpand?: () => void;
  /**
   * Every text file opens as code, in the editor with line numbers, markdown included: the Search
   * pane, whose results point at source lines.
   */
  source?: boolean;
  /** The `textZoom` key the zoom buttons save to; `filePreview` by default. */
  zoomKey?: TextZoomKey;
  /** Shown while no file is previewed. */
  emptyText?: string;
  /** An edit in the preview was saved. */
  onSaved?: () => void;
  /**
   * A `show(path)` with a path settled; `expandable` is whether the file is a text preview that
   * can fill the pane. Not called for `show(null)`.
   */
  onShown?: (expandable: boolean) => void;
}

type Current =
  | { kind: 'markdown'; path: string; view: MarkdownView }
  | { kind: 'plain' | 'code'; path: string; view: TextEditor; find: PreviewFind }
  | { kind: 'csv'; path: string; view: CsvView }
  | { kind: 'image'; path: string; view: ImageView }
  | { kind: 'notice'; path: string; view: BinaryNotice };

/** The right half of a Files pane: shows the selected file (docs/design/files.md section 4.12). */
export class FilePreview {
  readonly el: HTMLElement;
  private readonly opts: FilePreviewOptions;
  /** Kept across files, so the zoom holds while browsing. */
  private readonly zoom: ZoomButtons;
  private readonly expand: ExpandPreviewButton;
  /** The file's name, shown on the toolbar while expanded. */
  private readonly nameEl: HTMLSpanElement;
  private settings: Settings;
  private current: Current | null = null;
  private generation = 0;
  /** Set by `invalidate`: the next `show` re-reads the file even when it is already on screen. */
  private stale = false;
  /** A heading to scroll to once a markdown link's target file is shown. */
  private pendingAnchor: { path: string; fragment: string } | null = null;

  constructor(opts: FilePreviewOptions) {
    this.opts = opts;
    this.settings = opts.settings;
    this.el = document.createElement('div');
    this.el.className = 'file-preview';
    const zoomKey = opts.zoomKey ?? 'filePreview';
    this.zoom = new ZoomButtons(
      '',
      zoomKey,
      textZoom(zoomKey),
      (zoom) => {
        this.el.style.setProperty('--preview-zoom', String(zoom));
        const c = this.current;
        if (c?.kind === 'code' || c?.kind === 'csv') c.view.relayout();
      },
      this.el,
    );
    this.expand = new ExpandPreviewButton(() => this.opts.onToggleExpand?.());
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'preview-file-name';
    this.nameEl.hidden = true;
    opts.host.appendChild(this.el);
    this.showEmpty();
  }

  /** True when the current file has a preview that can fill the pane (anything but a notice). */
  get expandable(): boolean {
    const k = this.current?.kind;
    return k !== undefined && k !== 'notice';
  }

  /** Shows the file name and the Show file list button, or the Expand preview button. */
  setExpanded(expanded: boolean): void {
    this.expand.set(expanded);
    this.nameEl.hidden = !expanded;
  }

  /** The path being previewed, or null. */
  get path(): string | null {
    return this.current?.path ?? null;
  }

  /**
   * Shows a file, or clears the preview for null. `size` (from the listing) lets a file over
   * the text cap skip the read. Pending edits in the previous file are saved first. `line`
   * (1-based) scrolls a code view to that line and marks it; the file already on screen is
   * not re-read for it, unless `invalidate` ran since.
   */
  async show(path: string | null, size = 0, line: number | null = null): Promise<void> {
    const gen = ++this.generation;
    const anchor = this.takeAnchor(path);
    const c = this.current;
    if (path !== null && !this.stale && c?.path === path) {
      if (line !== null && c.kind === 'code') c.view.revealLine(line);
      if (anchor !== null && c.kind === 'markdown') c.view.scrollToAnchor(anchor);
      return;
    }
    await this.flush();
    if (gen !== this.generation) return;
    this.stale = false;
    this.clear();
    if (path === null) {
      this.showEmpty();
      return;
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    const kind = previewKind(name, size);
    if (kind === 'binary') {
      await this.setNotice(gen, path, name, size, 'tooLarge');
      return;
    }
    try {
      if (kind === 'image') {
        const view = await ImageView.open(path);
        if (gen !== this.generation) {
          view.dispose();
          return;
        }
        view.toolbar.prepend(this.fileName(path));
        view.toolbar.append(...this.expandButton());
        this.current = { kind, path, view };
        this.el.replaceChildren(view.el);
        this.opts.onShown?.(true);
        return;
      }
      const file = await fsReadText(path);
      if (gen !== this.generation) return;
      this.mount(path, this.opts.source ? 'code' : kind, file);
      const now = this.current;
      if (line !== null && now?.kind === 'code') now.view.revealLine(line);
      this.opts.onShown?.(true);
      // After onShown, which may expand the preview and so change where the heading sits.
      if (anchor !== null && now?.kind === 'markdown') requestAnimationFrame(() => now.view.scrollToAnchor(anchor));
    } catch (err) {
      if (gen !== this.generation) return;
      const failure = classifyReadError(err);
      if (failure === 'binary' || failure === 'tooLarge') {
        await this.setNotice(gen, path, name, size, failure);
        return;
      }
      this.setError(err);
      this.opts.onShown?.(false);
    }
  }

  /** The file may have changed on disk unseen; the next `show` reads it again. */
  invalidate(): void {
    this.stale = true;
  }

  /** The folder watch saw the selected entry's modified time change. */
  diskChanged(modified: number): void {
    const c = this.current;
    if (!c) return;
    if (c.kind === 'markdown' || c.kind === 'csv') void c.view.diskChanged(modified);
    else if (c.kind === 'image') c.view.diskChanged();
    else if (c.kind !== 'notice') c.view.diskChanged(modified);
  }

  focus(): void {
    const c = this.current;
    if (c && c.kind !== 'notice') c.view.focus();
  }

  /** Whether the preview has a find bar (a text preview). */
  get findable(): boolean {
    const c = this.current;
    return c !== null && c.kind !== 'notice' && c.kind !== 'image';
  }

  /** The page's selected text when the selection lies inside the preview, else ''. */
  selectedText(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
    if (!this.el.contains(sel.anchorNode) || !this.el.contains(sel.focusNode)) return '';
    return sel.toString();
  }

  /** Opens the find bar on a text preview; false when the preview has none. */
  openFind(): boolean {
    const c = this.current;
    if (!c || c.kind === 'notice' || c.kind === 'image') return false;
    (c.kind === 'markdown' || c.kind === 'csv' ? c.view.find : c.find).open();
    return true;
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    const c = this.current;
    if (c && c.kind !== 'notice' && c.kind !== 'image') c.view.applySettings(settings);
  }

  /** Saves pending edits; resolves once nothing is in flight. */
  async flush(): Promise<void> {
    const c = this.current;
    if (c && c.kind !== 'notice' && c.kind !== 'image') await c.view.flush();
  }

  dispose(): void {
    this.generation++;
    this.clear();
    this.el.remove();
  }

  private mount(path: string, kind: 'markdown' | 'csv' | 'plain' | 'code', file: FileText): void {
    const { keymap, dispatch } = this.opts;
    const { text, modified, lossy } = file;
    if (kind === 'markdown') {
      const view = new MarkdownView({
        path,
        text,
        modified,
        lossy,
        settings: this.settings,
        keymap,
        dispatch,
        onOpenFile: (target, fragment) => {
          this.pendingAnchor = fragment === undefined ? null : { path: target, fragment };
          this.opts.onOpenFile(target);
        },
      });
      view.toolbar.prepend(this.fileName(path));
      view.toolbar.append(this.zoom.el, ...this.expandButton());
      this.current = { kind, path, view };
      this.el.replaceChildren(view.el);
    } else if (kind === 'csv') {
      const view = new CsvView({ path, text, modified, lossy, settings: this.settings, keymap, dispatch, onSaved: this.opts.onSaved });
      view.toolbar.prepend(this.fileName(path));
      view.toolbar.append(this.zoom.el, ...this.expandButton());
      this.current = { kind, path, view };
      this.el.replaceChildren(view.el);
    } else {
      const lineNumbers = kind === 'code';
      const view = new TextEditor({
        path,
        text,
        modified,
        lossy,
        settings: this.settings,
        keymap,
        dispatch,
        lineNumbers,
        onSaved: this.opts.onSaved,
      });
      const find = new PreviewFind(() => view.findSurface());
      this.current = { kind, path, view, find };
      this.el.replaceChildren(framed(view.el, find, [this.zoom.el, ...this.expandButton()], this.fileName(path)));
    }
  }

  /**
   * The pending heading for `path`. It survives `show(null)`, which a Files pane sends while it
   * lists the link's folder, and any file shown clears it, so a stale one never fires later.
   */
  private takeAnchor(path: string | null): string | null {
    if (path === null) return null;
    const pending = this.pendingAnchor;
    this.pendingAnchor = null;
    return pending !== null && samePath(pending.path, path) ? pending.fragment : null;
  }

  private expandButton(): HTMLElement[] {
    return this.opts.onToggleExpand ? [this.expand.el] : [];
  }

  private fileName(path: string): HTMLSpanElement {
    this.nameEl.textContent = path.split(/[\\/]/).pop() ?? path;
    this.nameEl.title = path;
    return this.nameEl;
  }

  private async setNotice(
    gen: number,
    path: string,
    name: string,
    size: number,
    why: 'binary' | 'tooLarge',
  ): Promise<void> {
    const canOpen = await canOpenWithDefaultApp(path);
    if (gen !== this.generation) return;
    const view = new BinaryNotice({
      name,
      size,
      reason: why === 'binary' ? 'Binary file.' : 'Too large to preview.',
      onOpenInEditor: () => this.opts.onOpenInEditor(path),
      onOpenWithDefaultApp: canOpen ? () => void openWithDefaultApp(path) : undefined,
    });
    this.current = { kind: 'notice', path, view };
    this.el.replaceChildren(view.el);
    this.opts.onShown?.(false);
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
    div.textContent = this.opts.emptyText ?? 'Select a file to preview it.';
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

/** A view under a toolbar holding the file name, its find button and bar, then the zoom and expand buttons. */
function framed(view: HTMLElement, find: PreviewFind, trailing: HTMLElement[], name: HTMLElement): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'preview-frame';
  const toolbar = document.createElement('div');
  toolbar.className = 'preview-toolbar';
  toolbar.append(name, find.button, find.bar, ...trailing);
  frame.append(toolbar, view);
  return frame;
}
