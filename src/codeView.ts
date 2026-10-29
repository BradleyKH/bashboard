import { toFontFamily } from './pane';
import { revealIn, selectRange, type FindSurface } from './previewFind';
import type { Settings } from './settings';

/** Read-only monospaced text with a line-number gutter (docs/design.md section 4.12). */
export class CodeView {
  readonly el: HTMLElement;
  private readonly gutter: HTMLElement;
  private readonly code: HTMLElement;

  constructor(text: string, settings: Settings) {
    this.el = document.createElement('div');
    this.el.className = 'code-view';
    // Focusable so keys still reach the pane after the find bar closes.
    this.el.tabIndex = -1;
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

  findSurface(): FindSurface {
    return {
      textRoot: this.code,
      reveal: (range) => revealIn(this.el, range),
      done: (range) => {
        this.el.focus({ preventScroll: true });
        selectRange(range);
      },
    };
  }

  applySettings(settings: Settings): void {
    this.el.style.fontFamily = toFontFamily(settings.font.family);
    this.el.style.fontSize = `calc(${settings.font.size}px * var(--preview-zoom, 1))`;
  }

  dispose(): void {
    this.el.remove();
  }
}
