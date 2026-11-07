import type { ResponseBody } from './browserApi';
import { BrowserConsolePanel } from './browserConsolePanel';
import { BrowserNetworkPanel } from './browserNetworkPanel';
import { clampDrawerHeight, clampSplitRatio, type DevtoolsState, type DevtoolsTab } from './browserPaneModel';
import type { BrowserEvent } from './devtoolsModel';

export interface BrowserDevtoolsOptions {
  state: DevtoolsState;
  fetchBody: (requestId: string) => Promise<ResponseBody>;
  /** Pixels the drawer and the page share, for clamping its height. */
  availableHeight: () => number;
  /** Open, tab, height, or split changed. */
  onChange: () => void;
  /** The console's error count may have changed. */
  onCountsChange: () => void;
  /** A resize drag started or ended; the page frame must not swallow the pointer meanwhile. */
  onDragging: (dragging: boolean) => void;
}

/** The Local Browser's resizable bottom drawer with Console and Network tabs, or both side by side. */
export class BrowserDevtools {
  readonly element: HTMLElement;
  private readonly opts: BrowserDevtoolsOptions;
  private readonly consolePanel: BrowserConsolePanel;
  private readonly networkPanel: BrowserNetworkPanel;
  private readonly tabs = new Map<DevtoolsTab, HTMLButtonElement>();
  private readonly consoleBadge: HTMLElement;
  private readonly splitButton: HTMLButtonElement;
  private readonly panels: HTMLElement;
  private readonly divider: HTMLElement;
  private open: boolean;
  private tab: DevtoolsTab;
  private height: number;
  private split: boolean;
  private splitRatio: number;
  private endDrag: (() => void) | null = null;

  constructor(opts: BrowserDevtoolsOptions) {
    this.opts = opts;
    this.open = opts.state.open;
    this.tab = opts.state.tab;
    this.height = opts.state.height;
    this.split = opts.state.split;
    this.splitRatio = opts.state.splitRatio;
    this.consolePanel = new BrowserConsolePanel({ onCountsChange: () => this.countsChanged() });
    this.networkPanel = new BrowserNetworkPanel({ fetchBody: opts.fetchBody });

    this.element = document.createElement('div');
    this.element.className = 'lb-devtools';

    const handle = document.createElement('div');
    handle.className = 'lb-devtools-handle';
    handle.title = 'Drag to resize';
    handle.addEventListener('pointerdown', (e) => this.startHeightDrag(e, handle));

    const strip = document.createElement('div');
    strip.className = 'lb-devtools-tabs';
    this.consoleBadge = document.createElement('span');
    this.consoleBadge.className = 'lb-badge';
    this.consoleBadge.hidden = true;
    for (const [tab, label] of [
      ['console', 'Console'],
      ['network', 'Network'],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lb-devtools-tab';
      b.textContent = label;
      if (tab === 'console') b.append(this.consoleBadge);
      b.addEventListener('click', () => this.setTab(tab));
      this.tabs.set(tab, b);
      strip.append(b);
    }
    const spacer = document.createElement('span');
    spacer.className = 'lb-spacer';
    this.splitButton = document.createElement('button');
    this.splitButton.type = 'button';
    this.splitButton.className = 'lb-btn lb-devtools-split';
    this.splitButton.textContent = 'Split';
    this.splitButton.title = 'Show Console and Network side by side';
    this.splitButton.addEventListener('click', () => this.setSplit(!this.split));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lb-icon-btn';
    close.textContent = '×';
    close.title = 'Close DevTools';
    close.setAttribute('aria-label', 'Close DevTools');
    close.addEventListener('click', () => this.setOpen(false));
    strip.append(this.splitButton, spacer, close);

    this.divider = document.createElement('div');
    this.divider.className = 'lb-devtools-divider';
    this.divider.title = 'Drag to resize';
    this.divider.addEventListener('pointerdown', (e) => this.startSplitDrag(e));
    this.panels = document.createElement('div');
    this.panels.className = 'lb-devtools-panels';
    this.panels.append(this.consolePanel.element, this.divider, this.networkPanel.element);

    this.element.append(handle, strip, this.panels);
    this.apply();
  }

  /** Routes console and network events to their panels. */
  handle(ev: BrowserEvent): void {
    if (ev.kind === 'console' || ev.kind === 'exception') this.consolePanel.add(ev);
    else this.networkPanel.add(ev);
  }

  /** The page's top frame navigated to a new document. */
  navigated(): void {
    this.consolePanel.navigated();
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.apply();
    this.opts.onChange();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  state(): DevtoolsState {
    return { open: this.open, tab: this.tab, height: this.height, split: this.split, splitRatio: this.splitRatio };
  }

  errorCount(): number {
    return this.consolePanel.errorCount();
  }

  /** Re-clamps the height after the pane resizes. */
  layout(): void {
    if (this.open) this.element.style.height = `${clampDrawerHeight(this.height, this.opts.availableHeight())}px`;
  }

  dispose(): void {
    this.endDrag?.();
    this.consolePanel.dispose();
    this.networkPanel.dispose();
  }

  private setTab(tab: DevtoolsTab): void {
    if (this.split || tab === this.tab) return;
    this.tab = tab;
    this.apply();
    this.opts.onChange();
  }

  private setSplit(split: boolean): void {
    this.split = split;
    this.apply();
    this.opts.onChange();
  }

  private apply(): void {
    this.element.hidden = !this.open;
    this.element.classList.toggle('lb-split', this.split);
    this.splitButton.classList.toggle('active', this.split);
    this.splitButton.setAttribute('aria-pressed', String(this.split));
    // Split, both panels show and the tab buttons are only their labels.
    for (const [tab, b] of this.tabs) {
      b.classList.toggle('active', this.split || tab === this.tab);
      b.disabled = this.split;
    }
    const showConsole = this.split || this.tab === 'console';
    const showNetwork = this.split || this.tab === 'network';
    this.consolePanel.element.hidden = !showConsole;
    this.networkPanel.element.hidden = !showNetwork;
    this.divider.hidden = !this.split;
    this.consolePanel.setVisible(this.open && showConsole);
    this.networkPanel.setVisible(this.open && showNetwork);
    this.applySplitRatio();
    this.layout();
  }

  private applySplitRatio(): void {
    this.consolePanel.element.style.flexGrow = this.split ? String(this.splitRatio) : '';
    this.networkPanel.element.style.flexGrow = this.split ? String(1 - this.splitRatio) : '';
  }

  private countsChanged(): void {
    const n = this.consolePanel.errorCount();
    this.consoleBadge.hidden = n === 0;
    this.consoleBadge.textContent = n > 999 ? '999+' : String(n);
    this.opts.onCountsChange();
  }

  private startHeightDrag(e: PointerEvent, handle: HTMLElement): void {
    const startY = e.clientY;
    const startHeight = this.element.getBoundingClientRect().height;
    this.drag(e, handle, (ev) => {
      this.height = clampDrawerHeight(startHeight + (startY - ev.clientY), this.opts.availableHeight());
      this.element.style.height = `${this.height}px`;
    });
  }

  private startSplitDrag(e: PointerEvent): void {
    const box = this.panels.getBoundingClientRect();
    if (box.width <= 0) return;
    this.drag(e, this.divider, (ev) => {
      this.splitRatio = clampSplitRatio((ev.clientX - box.left) / box.width);
      this.applySplitRatio();
    });
  }

  private drag(e: PointerEvent, handle: HTMLElement, move: (ev: PointerEvent) => void): void {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    this.opts.onDragging(true);
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      this.endDrag = null;
      this.opts.onDragging(false);
      this.opts.onChange();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    this.endDrag = end;
  }
}
