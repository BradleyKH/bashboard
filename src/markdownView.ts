import { invoke } from '@tauri-apps/api/core';
import { colorFences, stripFences } from './code/fenceColors';
import { type CodeColorsMode, codeColorsMode } from './code/schemes';
import type { Action, Keymap } from './keymap';
import { isOpenableUrl } from './links';
import { classifyLink, renderMarkdown, samePath } from './markdownRender';
import { PreviewFind, revealIn, selectRange, type FindSurface } from './previewFind';
import { fsReadText } from './repoFiles';
import type { Settings } from './settings';
import { TextEditor } from './textEditor';

export interface MarkdownViewOptions {
  path: string;
  text: string;
  modified: number;
  lossy: boolean;
  settings: Settings;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  /** A relative link to another file was clicked; `path` is absolute, `fragment` the heading slug if any. */
  onOpenFile: (path: string, fragment?: string) => void;
  /** False hides the Edit toggle: the Search preview edits markdown through its Raw mode instead. */
  editable?: boolean;
}

/** Rendered markdown with an Edit toggle (docs/design/files.md section 4.12). */
export class MarkdownView {
  readonly el: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly body: HTMLElement;
  readonly find: PreviewFind;
  /** Where the owner adds its own controls, after Edit and Find. */
  readonly toolbar: HTMLElement;
  private readonly opts: MarkdownViewOptions;
  private text: string;
  private modified: number;
  private lossy: boolean;
  private editor: TextEditor | null = null;
  private settings: Settings;
  private disposed = false;
  private codeColors: CodeColorsMode;
  /** Bumped on every render and mode change, so a fence pass that lands late is dropped. */
  private fenceGeneration = 0;

  constructor(opts: MarkdownViewOptions) {
    this.opts = opts;
    this.text = opts.text;
    this.modified = opts.modified;
    this.lossy = opts.lossy;
    this.settings = opts.settings;
    this.codeColors = codeColorsMode(opts.settings.codeColors.scheme);

    this.el = document.createElement('div');
    this.el.className = 'markdown-view';
    const toolbar = document.createElement('div');
    toolbar.className = 'preview-toolbar';
    this.toolbar = toolbar;
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.addEventListener('click', () => void this.toggleEdit());
    this.find = new PreviewFind(() => this.findSurface());
    if (opts.editable === false) toolbar.append(this.find.button, this.find.bar);
    else toolbar.append(this.toggle, this.find.button, this.find.bar);
    this.body = document.createElement('div');
    this.body.className = 'markdown-body';
    this.body.tabIndex = -1;
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.el.append(toolbar, this.body);
    this.showRendered();
  }

  /** True while the text editor is showing. */
  get editing(): boolean {
    return this.editor !== null;
  }

  focus(): void {
    if (this.editor) this.editor.focus();
    else this.body.focus();
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.editor?.applySettings(settings);
    this.setCodeColors(codeColorsMode(settings.codeColors.scheme));
  }

  /** Colors or uncolors fenced blocks; the editor, while editing, follows the settings itself. */
  private setCodeColors(mode: CodeColorsMode): void {
    if (mode === this.codeColors) return;
    this.codeColors = mode;
    if (this.editor) return;
    if (mode === 'plain') {
      this.fenceGeneration++;
      stripFences(this.body);
    } else {
      this.runFencePass();
    }
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
      this.renderBody();
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
      this.showRendered();
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
      language: 'markdown',
    });
    this.fenceGeneration++;
    this.body.replaceChildren(this.editor.el);
    this.body.classList.add('editing');
    this.toggle.textContent = 'Done';
    this.toggle.title = 'Show the rendered markdown';
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

  private showRendered(): void {
    this.body.classList.remove('editing');
    this.toggle.textContent = 'Edit';
    this.toggle.title = 'Edit this file';
    this.renderBody();
  }

  private renderBody(): void {
    this.body.innerHTML = renderMarkdown(this.text);
    this.fenceGeneration++;
    if (this.codeColors === 'syntax') this.runFencePass();
  }

  private runFencePass(): void {
    const gen = ++this.fenceGeneration;
    void colorFences(this.body, () => gen === this.fenceGeneration && !this.disposed && !this.editor);
  }

  private onClick(e: MouseEvent): void {
    const anchor = (e.target as Element | null)?.closest('a');
    if (!anchor) return;
    // WebView2 would navigate the page itself for any link.
    e.preventDefault();
    const target = classifyLink(anchor.getAttribute('href') ?? '', this.opts.path);
    if (target.kind === 'external') {
      if (isOpenableUrl(target.url)) {
        invoke('open_url', { url: target.url }).catch((err: unknown) => console.warn('open_url failed', err));
      }
    } else if (target.kind === 'file') {
      if (target.fragment !== undefined && samePath(target.path, this.opts.path)) this.scrollToAnchor(target.fragment);
      else this.opts.onOpenFile(target.path, target.fragment);
    } else if (target.kind === 'anchor') {
      this.scrollToAnchor(target.fragment);
    }
  }

  /** Scrolls the rendered preview to the heading whose slug is `fragment`; no-op while editing. */
  scrollToAnchor(fragment: string): void {
    if (this.editor) return;
    const heading = this.body.querySelector(`[data-anchor="${CSS.escape(fragment.toLowerCase())}"]`);
    if (!heading) return;
    // Scroll only the preview; scrollIntoView would also move the pane's ancestors.
    const top = heading.getBoundingClientRect().top - this.body.getBoundingClientRect().top;
    this.body.scrollTop += top;
  }
}
