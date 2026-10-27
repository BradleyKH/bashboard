import { toFontFamily } from './pane';
import type { Settings } from './settings';

/** Read-only monospaced text with a line-number gutter (docs/design.md section 4.12). */
export class CodeView {
  readonly el: HTMLElement;
  private readonly gutter: HTMLElement;
  private readonly code: HTMLElement;

  constructor(text: string, settings: Settings) {
    this.el = document.createElement('div');
    this.el.className = 'code-view';
    this.gutter = document.createElement('pre');
    this.gutter.className = 'code-gutter';
    this.code = document.createElement('pre');
    this.code.className = 'code-text';
    this.el.append(this.gutter, this.code);
    this.applySettings(settings);
    this.setText(text);
  }

  setText(text: string): void {
    const lines = text.split('\n');
    // A trailing newline ends the last line rather than starting another.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    this.code.textContent = lines.join('\n');
    this.gutter.textContent = lines.map((_, i) => String(i + 1)).join('\n');
  }

  applySettings(settings: Settings): void {
    this.el.style.fontFamily = toFontFamily(settings.font.family);
    this.el.style.fontSize = `${settings.font.size}px`;
  }

  dispose(): void {
    this.el.remove();
  }
}
