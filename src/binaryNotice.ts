import { formatSize } from './formatSize';

export interface BinaryNoticeOptions {
  name: string;
  size: number;
  reason: string;
  onOpenInEditor: () => void;
  /** Omitted when the file would run as a program if opened. */
  onOpenWithDefaultApp?: () => void;
}

/** Shown for binary files and files over the text cap (docs/design/files.md section 4.12). */
export class BinaryNotice {
  readonly el: HTMLElement;

  constructor(o: BinaryNoticeOptions) {
    this.el = document.createElement('div');
    this.el.className = 'preview-notice';
    const title = document.createElement('div');
    title.className = 'notice-name';
    title.textContent = o.name;
    const detail = document.createElement('div');
    detail.textContent = o.size > 0 ? `${formatSize(o.size)}. ${o.reason}` : o.reason;
    const buttons = document.createElement('div');
    buttons.className = 'notice-actions';
    if (o.onOpenWithDefaultApp) buttons.append(button('Open with default app', o.onOpenWithDefaultApp));
    buttons.append(button('Open in editor', o.onOpenInEditor));
    this.el.append(title, detail, buttons);
  }

  dispose(): void {
    this.el.remove();
  }
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
