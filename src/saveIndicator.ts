import type { SaveStatus } from './textEditorModel';

/** Where a text editor reports its save state; `SaveIndicator` is the one on screen. */
export interface SaveStatusSink {
  update(status: SaveStatus, error: string | null): void;
  /** A save landed, or Ctrl+S found nothing to save: confirm it briefly. */
  saved(): void;
  readOnly(readOnly: boolean): void;
  /** The editor went away; show nothing. */
  reset(): void;
}

/** A local write takes milliseconds, so "Saving..." shows only for one slow enough to notice. */
const SAVING_LABEL_DELAY_MS = 300;
/** How long "Saved" stays before it fades. */
const SAVED_SHOW_MS = 1500;

export interface SaveIndicatorOptions {
  /** The indicator was clicked while showing a failed save. */
  onRetry: () => void;
  /** The failed state began or ended, for a mark on the pane's title strip. */
  onFailedChange?: (failed: boolean) => void;
}

/** The preview toolbar's save status (docs/design/files.md section 4.12, Save status). */
export class SaveIndicator implements SaveStatusSink {
  readonly el: HTMLElement;
  private status: SaveStatus = 'clean';
  private error: string | null = null;
  private locked = false;
  private flashing = false;
  private savingLabel = false;
  private savingTimer: number | null = null;
  private flashTimer: number | null = null;

  constructor(private readonly opts: SaveIndicatorOptions) {
    this.el = document.createElement('span');
    this.el.className = 'save-indicator';
    this.el.setAttribute('role', 'status');
    this.el.addEventListener('click', () => {
      if (this.status === 'failed') this.opts.onRetry();
    });
    this.render();
  }

  update(status: SaveStatus, error: string | null): void {
    const wasFailed = this.status === 'failed';
    this.status = status;
    this.error = error;
    if (status !== 'clean') this.stopFlash();
    if (status === 'saving') {
      if (this.savingTimer === null && !this.savingLabel) {
        this.savingTimer = window.setTimeout(() => {
          this.savingTimer = null;
          this.savingLabel = true;
          this.render();
        }, SAVING_LABEL_DELAY_MS);
      }
    } else {
      this.clearSavingTimer();
      this.savingLabel = false;
    }
    if (wasFailed !== (status === 'failed')) this.opts.onFailedChange?.(status === 'failed');
    this.render();
  }

  saved(): void {
    if (this.status !== 'clean') return;
    this.stopFlash();
    this.flashing = true;
    this.render();
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = null;
      this.flashing = false;
      this.render();
    }, SAVED_SHOW_MS);
  }

  readOnly(readOnly: boolean): void {
    this.locked = readOnly;
    this.render();
  }

  reset(): void {
    this.update('clean', null);
    this.stopFlash();
    this.locked = false;
    this.render();
  }

  dispose(): void {
    this.clearSavingTimer();
    this.stopFlash();
  }

  private render(): void {
    const { text, title, state } = this.view();
    this.el.textContent = text;
    this.el.title = title;
    this.el.dataset.state = state;
  }

  private view(): { text: string; title: string; state: string } {
    switch (this.status) {
      case 'failed':
        return { text: '⚠ Not saved', title: `${this.error ?? 'The last save failed.'} Click to try again.`, state: 'failed' };
      case 'conflict':
        return { text: '●', title: 'The file changed on disk: choose Reload or Keep mine', state: 'conflict' };
      case 'saving':
        if (this.savingLabel) return { text: 'Saving…', title: 'Saving', state: 'saving' };
        return { text: '●', title: 'Saving', state: 'pending' };
      case 'pending':
        return { text: '●', title: 'Unsaved edits, saving shortly', state: 'pending' };
      case 'clean':
        if (this.locked) return { text: '🔒', title: 'Read-only: this file is not valid UTF-8', state: 'locked' };
        // Idle keeps the text, transparent, so the fade runs to the end and the width holds still.
        if (this.flashing) return { text: '✓ Saved', title: 'All edits are saved', state: 'saved' };
        return { text: '✓ Saved', title: '', state: 'idle' };
    }
  }

  private stopFlash(): void {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.flashing = false;
  }

  private clearSavingTimer(): void {
    if (this.savingTimer !== null) {
      window.clearTimeout(this.savingTimer);
      this.savingTimer = null;
    }
  }
}
