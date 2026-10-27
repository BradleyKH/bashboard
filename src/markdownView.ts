import { invoke } from '@tauri-apps/api/core';
import type { Action, Keymap } from './keymap';
import { isOpenableUrl } from './links';
import { classifyLink, renderMarkdown } from './markdownRender';
import { fsReadText } from './repoFiles';
import type { Settings } from './settings';
import { TextEditor } from './textEditor';

export interface MarkdownViewOptions {
  path: string;
  text: string;
  modified: number;
  settings: Settings;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  /** A relative link to another file was clicked; `path` is absolute. */
  onOpenFile: (path: string) => void;
}

/** Rendered markdown with an Edit toggle (docs/design.md section 4.12). */
export class MarkdownView {
  readonly el: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly opts: MarkdownViewOptions;
  private text: string;
  private modified: number;
  private editor: TextEditor | null = null;
  private settings: Settings;
  private disposed = false;

  constructor(opts: MarkdownViewOptions) {
    this.opts = opts;
    this.text = opts.text;
    this.modified = opts.modified;
    this.settings = opts.settings;

    this.el = document.createElement('div');
    this.el.className = 'markdown-view';
    const toolbar = document.createElement('div');
    toolbar.className = 'preview-toolbar';
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.addEventListener('click', () => void this.toggleEdit());
    toolbar.appendChild(this.toggle);
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
    this.editor?.dispose();
    this.el.remove();
  }

  private async toggleEdit(): Promise<void> {
    if (this.editor) {
      await this.editor.flush();
      this.text = this.editor.text;
      this.modified = this.editor.modified;
      this.editor.dispose();
      this.editor = null;
      this.showRendered();
      return;
    }
    this.editor = new TextEditor({
      path: this.opts.path,
      text: this.text,
      modified: this.modified,
      settings: this.settings,
      keymap: this.opts.keymap,
      dispatch: this.opts.dispatch,
    });
    this.body.replaceChildren(this.editor.el);
    this.body.classList.add('editing');
    this.toggle.textContent = 'Done';
    this.toggle.title = 'Show the rendered markdown';
    this.editor.focus();
  }

  private showRendered(): void {
    this.body.classList.remove('editing');
    this.toggle.textContent = 'Edit';
    this.toggle.title = 'Edit this file';
    this.renderBody();
  }

  private renderBody(): void {
    this.body.innerHTML = renderMarkdown(this.text);
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
      this.opts.onOpenFile(target.path);
    }
  }
}
