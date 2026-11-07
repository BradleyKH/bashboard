import { invoke } from '@tauri-apps/api/core';
import { imageMime } from './filesModel';
import { formatSize } from './formatSize';

/**
 * An image file, fitted to the preview; clicking it toggles actual size (docs/design/files.md
 * section 4.12). The bytes come through `fs_read_bytes` as a `blob:` URL, the one image source
 * the CSP allows besides the app's own files.
 */
export class ImageView {
  readonly el: HTMLElement;
  /** Where the owner adds its own controls, after the size info and Fit toggle. */
  readonly toolbar: HTMLElement;
  private readonly info: HTMLSpanElement;
  private readonly fitButton: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly path: string;
  private url: string | null = null;
  private bytes = 0;
  private fit = true;
  private generation = 0;
  private disposed = false;

  private constructor(path: string) {
    this.path = path;
    this.el = document.createElement('div');
    this.el.className = 'image-view';
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'preview-toolbar';
    this.info = document.createElement('span');
    this.info.className = 'image-info';
    this.fitButton = document.createElement('button');
    this.fitButton.type = 'button';
    this.fitButton.addEventListener('click', () => this.setFit(!this.fit));
    this.toolbar.append(this.info, this.fitButton);
    this.body = document.createElement('div');
    this.body.className = 'image-body';
    this.body.tabIndex = -1;
    this.img = document.createElement('img');
    this.img.alt = '';
    this.img.draggable = false;
    this.img.addEventListener('click', () => this.setFit(!this.fit));
    this.img.addEventListener('load', () => this.showInfo());
    this.body.appendChild(this.img);
    this.el.append(this.toolbar, this.body);
    this.setFit(true);
  }

  /** Reads the image; rejects as `fs_read_bytes` does, or when the bytes do not decode. */
  static async open(path: string): Promise<ImageView> {
    const view = new ImageView(path);
    try {
      await view.load();
    } catch (err) {
      view.dispose();
      throw err;
    }
    return view;
  }

  focus(): void {
    this.body.focus();
  }

  /** The file changed on disk: show the new bytes, keeping the old image if the read fails. */
  diskChanged(): void {
    void this.load().catch(() => {
      // Mid-write or gone; the next change or the pane's next listing settles it.
    });
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.el.remove();
  }

  private async load(): Promise<void> {
    const gen = ++this.generation;
    const buf = await invoke<ArrayBuffer>('fs_read_bytes', { path: this.path });
    if (this.disposed || gen !== this.generation) return;
    const name = this.path.split(/[\\/]/).pop() ?? this.path;
    const mime = imageMime(name);
    const url = URL.createObjectURL(new Blob([buf], mime ? { type: mime } : {}));
    const probe = new Image();
    probe.src = url;
    try {
      await probe.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('binary: not a readable image');
    }
    if (this.disposed || gen !== this.generation) {
      URL.revokeObjectURL(url);
      return;
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = url;
    this.bytes = buf.byteLength;
    this.img.src = url;
  }

  private setFit(fit: boolean): void {
    this.fit = fit;
    this.body.classList.toggle('fit', fit);
    this.fitButton.textContent = fit ? 'Actual size' : 'Fit';
    this.fitButton.title = fit ? 'Show the image at its actual size' : 'Fit the image to the preview';
  }

  private showInfo(): void {
    const { naturalWidth: w, naturalHeight: h } = this.img;
    this.info.textContent = `${w} × ${h} · ${formatSize(this.bytes)}`;
  }
}
