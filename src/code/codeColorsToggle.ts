import './codeColorsToggle.css';
import type { CodeColorsMode } from './codeColorsStore';

/**
 * The Plain | Syntax button group on a surface that shows code (docs/design/files.md section 4.22).
 * Disabled, with a tooltip, while the file has no language to color.
 */
export class CodeColorsToggle {
  readonly el: HTMLSpanElement;
  private readonly plainBtn: HTMLButtonElement;
  private readonly syntaxBtn: HTMLButtonElement;
  private current: CodeColorsMode = 'syntax';
  private available = true;

  constructor(private readonly onChange: (mode: CodeColorsMode) => void) {
    this.el = document.createElement('span');
    this.el.className = 'code-colors';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Code colors');
    this.plainBtn = this.button('Plain', 'Show every character in the text color', 'plain');
    this.syntaxBtn = this.button('Syntax', 'Color code by language', 'syntax');
    this.el.append(this.plainBtn, this.syntaxBtn);
    this.sync();
  }

  get mode(): CodeColorsMode {
    return this.current;
  }

  /** Shows `mode` as chosen, without calling `onChange`. */
  set(mode: CodeColorsMode): void {
    this.current = mode;
    this.sync();
  }

  /** Whether the shown file has a language; unavailable disables both buttons. */
  setAvailable(available: boolean): void {
    this.available = available;
    this.sync();
  }

  private button(label: string, title: string, mode: CodeColorsMode): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.dataset.title = title;
    btn.addEventListener('click', () => {
      if (this.current === mode) return;
      this.current = mode;
      this.sync();
      this.onChange(mode);
    });
    return btn;
  }

  private sync(): void {
    for (const btn of [this.plainBtn, this.syntaxBtn]) {
      btn.disabled = !this.available;
      btn.title = this.available ? (btn.dataset.title ?? '') : 'No colors for this file type';
    }
    this.plainBtn.setAttribute('aria-pressed', String(this.current === 'plain'));
    this.syntaxBtn.setAttribute('aria-pressed', String(this.current === 'syntax'));
  }
}
