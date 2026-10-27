import { formatSize } from './formatSize';

/** Shown for binary files and files over the text cap (docs/design.md section 4.12). */
export class BinaryNotice {
  readonly el: HTMLElement;

  constructor(name: string, size: number, reason: string, onOpenInEditor: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'preview-notice';
    const title = document.createElement('div');
    title.className = 'notice-name';
    title.textContent = name;
    const detail = document.createElement('div');
    detail.textContent = size > 0 ? `${formatSize(size)}. ${reason}` : reason;
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Open in editor';
    open.addEventListener('click', onOpenInEditor);
    this.el.append(title, detail, open);
  }

  dispose(): void {
    this.el.remove();
  }
}
