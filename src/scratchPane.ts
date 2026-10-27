import './scratchPane.css';
import { DebouncedSaver } from './debouncedSaver';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import type { PaneView } from './paneView';
import { isScratchEmpty, SCRATCH_SAVE_DELAY_MS, scratchTitle } from './scratchModel';
import type { Settings } from './settings';
import { textFieldOwns } from './textPaneKeys';
import { showToast } from './toast';

export interface ScratchPaneOptions {
  host: HTMLElement;
  paneId: string;
  scratchId: string;
  settings: Settings;
  /** Initial text; a promise leaves the pad read-only until it settles. */
  text?: string | Promise<string>;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  save: (id: string, text: string) => Promise<void>;
  saveAs: (text: string) => Promise<string | null>;
}

/** A plain text scratch pad (docs/design.md section 4.15). */
export class ScratchPane implements PaneView {
  readonly kind = 'scratch' as const;
  readonly paneId: string;
  readonly folder = null;
  readonly scratchId: string;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly area: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly saver: DebouncedSaver<string>;
  private readonly opts: ScratchPaneOptions;
  private canSend = true;
  private disposed = false;
  private saveCancelled = false;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: ScratchPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.scratchId = opts.scratchId;

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body scratch-body';
    this.body.style.cssText = 'position: relative; z-index: 1; flex: 1 1 auto; min-width: 0; min-height: 0;';

    const toolbar = document.createElement('div');
    toolbar.className = 'scratch-toolbar';
    this.sendBtn = this.button(toolbar, 'Send', 'Paste into the last focused terminal (Ctrl+Enter)', () => this.send());
    this.button(toolbar, 'Copy', 'Copy all text', () => this.copy());
    this.button(toolbar, 'Clear', 'Empty the pad', () => this.clear());
    this.button(toolbar, 'Save as', 'Save to a file', () => void this.saveToFile());

    this.area = document.createElement('textarea');
    this.area.className = 'scratch-text';
    this.area.spellcheck = false;
    this.applySettings(opts.settings);
    this.body.append(toolbar, this.area);
    this.host.appendChild(this.body);

    this.saver = new DebouncedSaver(
      () => this.area.value,
      (text) => (this.saveCancelled ? Promise.resolve() : opts.save(this.scratchId, text)),
      SCRATCH_SAVE_DELAY_MS,
    );

    this.listen(this.area, 'input', () => this.changed());
    this.listen(this.area, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(this.host, 'focusin', () => opts.onFocus());

    if (opts.text instanceof Promise) {
      this.area.readOnly = true;
      opts.text.then(
        (t) => {
          if (this.disposed) return;
          this.area.value = t;
          this.area.readOnly = false;
        },
        (e) => {
          if (this.disposed) return;
          this.area.readOnly = false;
          showToast(`Could not load the scratch pad: ${e}`);
        },
      );
    } else if (opts.text) {
      this.area.value = opts.text;
    }
  }

  get text(): string {
    return this.area.value;
  }

  isEmpty(): boolean {
    return isScratchEmpty(this.area.value);
  }

  title(): string {
    return scratchTitle(this.area.value);
  }

  /** Saves pending text now. */
  async flush(): Promise<void> {
    try {
      await this.saver.flush();
    } catch (e) {
      showToast(`Could not save the scratch pad: ${e}`);
    }
  }

  /** Stops saving, for a pad whose file is being deleted; resolves once no save can recreate it. */
  cancelSave(): Promise<void> {
    this.saveCancelled = true;
    return this.saver.cancel();
  }

  /** Disables Send while the tab has no terminal. */
  setCanSend(enabled: boolean): void {
    this.canSend = enabled;
    this.sendBtn.disabled = !enabled;
  }

  focus(): void {
    this.area.focus();
  }

  setExpanded(_expanded: boolean): void {}

  applySettings(settings: Settings): void {
    this.area.style.fontFamily = toFontFamily(settings.font.family);
    this.area.style.fontSize = `${settings.font.size}px`;
  }

  cellSize(): CellSize {
    const cs = getComputedStyle(this.area);
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(10);
    probe.style.cssText = 'position: absolute; visibility: hidden; white-space: pre; font: inherit;';
    this.area.parentElement!.appendChild(probe);
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    const width = probe.getBoundingClientRect().width / 10;
    probe.remove();
    const lh = parseFloat(cs.lineHeight);
    const height = Number.isFinite(lh) ? lh : parseFloat(cs.fontSize) * 1.2;
    const innerPadX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const innerPadY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return {
      width,
      height,
      // Everything in the host outside the textarea's content box: borders, strip, toolbar, padding.
      padX: this.host.offsetWidth - this.area.clientWidth + innerPadX + 1,
      padY: this.host.offsetHeight - this.area.clientHeight + innerPadY + 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.body.remove();
  }

  private changed(): void {
    this.opts.onChange(this.area.value);
    this.saver.schedule();
  }

  private send(): void {
    if (this.canSend) this.opts.onSend(this.area.value);
  }

  private copy(): void {
    navigator.clipboard.writeText(this.area.value).catch((e) => showToast(`Could not copy: ${e}`));
  }

  private clear(): void {
    this.area.value = '';
    this.changed();
    this.area.focus();
  }

  private async saveToFile(): Promise<void> {
    try {
      const path = await this.opts.saveAs(this.area.value);
      if (path) showToast(`Saved to ${path}`);
    } catch (e) {
      showToast(`Could not save: ${e}`);
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.send();
      return;
    }
    const action = lookup(this.opts.keymap(), e);
    if (action && !textFieldOwns(action) && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private button(parent: HTMLElement, label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
