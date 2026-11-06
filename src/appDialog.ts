import './appDialog.css';
import { DIALOG_TABS, DIALOG_TAB_LABELS, stepTab, type DialogTab } from './appDialogModel';

/** What the dialog needs from a tab; each tab mounts on its first visit and unmounts on close. */
export interface DialogTabView {
  mount(host: HTMLElement): void;
  unmount(): void;
  /** The tab became visible again after its first visit. */
  show?(): void;
  /** Another tab replaced this one. */
  hide?(): void;
  /** A key typed in the dialog while this tab shows; true when the tab consumed it. */
  onKey?(e: KeyboardEvent): boolean;
}

export interface AppDialogCallbacks {
  /** Dismissed; the caller refocuses the terminal. */
  onClose(): void;
  /** The tab whose workspace action `e` runs, so the same keys switch tabs inside the dialog. */
  tabForKey(e: KeyboardEvent): DialogTab | null;
}

interface Slot {
  host: HTMLElement;
  button: HTMLButtonElement;
  mounted: boolean;
}

/**
 * The Help, Settings, Accounts, Shortcuts, CLI, and About dialog (docs/design/app.md section 4.18).
 */
export class AppDialog {
  private backdrop: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private slots = new Map<DialogTab, Slot>();
  private current: DialogTab | null = null;

  constructor(
    private readonly views: Record<DialogTab, DialogTabView>,
    private readonly callbacks: AppDialogCallbacks,
  ) {}

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  /** The dialog box, for tabs that move focus back to it. */
  get element(): HTMLElement | null {
    return this.box;
  }

  open(tab: DialogTab): void {
    if (!this.backdrop) this.build();
    this.select(tab);
  }

  close(): void {
    if (!this.backdrop) return;
    for (const [tab, slot] of this.slots) if (slot.mounted) this.views[tab].unmount();
    this.slots.clear();
    this.current = null;
    this.backdrop.remove();
    this.backdrop = null;
    this.box = null;
  }

  private build(): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'app-dialog-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) {
        e.preventDefault();
        this.dismiss();
      }
    });

    const box = document.createElement('div');
    box.className = 'app-dialog';
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Bashboard');
    box.addEventListener('keydown', (e) => this.onKey(e));

    const header = document.createElement('div');
    header.className = 'app-dialog-header';
    const tabs = document.createElement('div');
    tabs.className = 'app-dialog-tabs';
    tabs.setAttribute('role', 'tablist');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'app-dialog-close';
    close.textContent = '×';
    close.title = 'Close (Escape)';
    close.addEventListener('click', () => this.dismiss());
    header.append(tabs, close);

    const panel = document.createElement('div');
    panel.className = 'app-dialog-panel';
    for (const tab of DIALOG_TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-dialog-tab';
      button.id = `app-dialog-tab-${tab}`;
      button.textContent = DIALOG_TAB_LABELS[tab];
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `app-dialog-panel-${tab}`);
      button.addEventListener('click', () => this.select(tab));
      tabs.append(button);
      const host = document.createElement('div');
      host.className = 'app-dialog-tab-panel';
      host.id = `app-dialog-panel-${tab}`;
      host.setAttribute('role', 'tabpanel');
      host.setAttribute('aria-labelledby', button.id);
      host.hidden = true;
      panel.append(host);
      this.slots.set(tab, { host, button, mounted: false });
    }

    box.append(header, panel);
    backdrop.append(box);
    document.body.append(backdrop);
    this.backdrop = backdrop;
    this.box = box;
  }

  private select(tab: DialogTab): void {
    const slot = this.slots.get(tab);
    if (!slot || !this.backdrop) return;
    if (this.current !== tab) {
      if (this.current) this.views[this.current].hide?.();
      for (const [t, s] of this.slots) {
        const on = t === tab;
        s.host.hidden = !on;
        s.button.classList.toggle('active', on);
        s.button.setAttribute('aria-selected', String(on));
        s.button.tabIndex = on ? 0 : -1;
      }
      this.current = tab;
      if (slot.mounted) {
        this.views[tab].show?.();
      } else {
        slot.mounted = true;
        this.views[tab].mount(slot.host);
      }
      // Settings previews colors and brightness live, so nothing dims the window behind it.
      this.backdrop.classList.toggle('app-dialog-see-through', tab === 'settings');
    }
    this.box?.focus();
  }

  private dismiss(): void {
    this.close();
    this.callbacks.onClose();
  }

  private onKey(e: KeyboardEvent): void {
    // Keep keys away from the workspace keymap and xterm.
    e.stopPropagation();
    if (this.current && this.views[this.current].onKey?.(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismiss();
      return;
    }
    const step = tabStep(e);
    if (step !== 0 && this.current) {
      e.preventDefault();
      this.select(stepTab(this.current, step));
      this.slots.get(this.current)?.button.focus();
      return;
    }
    // A plain key may be typing into a field, so only chords and function keys switch tabs.
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) return;
    const tab = this.callbacks.tabForKey(e);
    if (!tab) return;
    e.preventDefault();
    if (tab === this.current) this.dismiss();
    else this.select(tab);
  }
}

/** Ctrl+Tab and Ctrl+PageDown step right, their Shift and PageUp forms left; arrows do too on the tab strip. */
function tabStep(e: KeyboardEvent): number {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.key === 'Tab') return e.shiftKey ? -1 : 1;
    if (!e.shiftKey && e.key === 'PageDown') return 1;
    if (!e.shiftKey && e.key === 'PageUp') return -1;
  }
  const onTab = e.target instanceof HTMLElement && e.target.getAttribute('role') === 'tab';
  if (onTab && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    if (e.key === 'ArrowRight') return 1;
    if (e.key === 'ArrowLeft') return -1;
  }
  return 0;
}
