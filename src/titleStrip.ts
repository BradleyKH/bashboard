import { kindMenu } from './kindMenu';
import { paneKindInfo, type PaneKind } from './paneKinds';
import type { TerminalStatus } from './terminalStatus';

export interface TitleStripHooks {
  onCollapse(): void;
  /** Fired by the close button; closes the pane as Ctrl+W does. */
  onClose(): void;
  /** Fired by the zoom button; only reachable while `setZoom` reports it available. */
  onZoom?(): void;
  /** Fired when the user picks a different kind from the kind menu. */
  onChooseKind?(kind: PaneKind): void;
  /** Fired once the pointer has moved past the drag threshold; `e` is the move event that crossed it. */
  onDragStart(e: PointerEvent): void;
}

export interface TitleStripState {
  title: string;
  path: string;
  /** Shown as the status dot for terminals; other kinds omit it. */
  status?: TerminalStatus;
}

export interface TitleStripZoomState {
  /** Two or more expanded panes in the tab; otherwise the button is hidden. */
  available: boolean;
  zoomed: boolean;
  /** A hidden pane in the zoomed tab is marked for attention (docs/design.md section 4.2). */
  attention: boolean;
}

const DRAG_THRESHOLD_PX = 4;

/** The per-pane title bar: kind button, status dot, title, collapse, zoom, and close buttons (docs/design.md section 4.4). */
export class TitleStrip {
  readonly el: HTMLElement;
  private readonly kindButton: HTMLButtonElement;
  private readonly dot: HTMLElement;
  private readonly title: HTMLElement;
  private readonly zoomButton: HTMLButtonElement;
  private kind: PaneKind;

  constructor(
    private readonly hooks: TitleStripHooks,
    kind: PaneKind = 'terminal',
  ) {
    this.kind = kind;
    this.el = document.createElement('div');
    this.el.className = 'pane-strip';

    this.kindButton = document.createElement('button');
    this.kindButton.type = 'button';
    this.kindButton.className = 'strip-kind';
    this.kindButton.addEventListener('click', (e) => {
      e.stopPropagation();
      kindMenu.open(this.kindButton, this.kind, (k) => this.hooks.onChooseKind?.(k));
    });
    this.setKind(kind);

    this.dot = document.createElement('span');
    this.dot.className = 'status-dot idle';

    this.title = document.createElement('span');
    this.title.className = 'strip-title';

    this.zoomButton = document.createElement('button');
    this.zoomButton.type = 'button';
    this.zoomButton.className = 'strip-zoom';
    this.zoomButton.hidden = true;
    this.zoomButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onZoom?.();
    });
    this.setZoom({ available: false, zoomed: false, attention: false });

    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'strip-collapse';
    collapse.textContent = '−';
    collapse.title = 'Collapse pane';
    collapse.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onCollapse();
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'strip-close';
    close.textContent = '×';
    close.title = 'Close pane (Ctrl+W)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onClose();
    });

    this.el.append(this.kindButton, this.dot, this.title, collapse, this.zoomButton, close);

    // Keeps focus in xterm; pointer events and click handlers are unaffected.
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
  }

  setKind(kind: PaneKind): void {
    this.kind = kind;
    const info = paneKindInfo(kind);
    this.kindButton.textContent = info.icon;
    this.kindButton.title = `${info.label}, change pane kind`;
  }

  setZoom(state: TitleStripZoomState): void {
    this.zoomButton.hidden = !state.available;
    this.zoomButton.classList.toggle('zoomed', state.zoomed);
    this.zoomButton.classList.toggle('attention', state.attention);
    this.zoomButton.textContent = state.zoomed ? '⧉' : '⤢';
    this.zoomButton.title = state.zoomed ? 'Restore panes (Ctrl+Shift+Z)' : 'Zoom pane (Ctrl+Shift+Z)';
  }

  update(state: TitleStripState): void {
    this.dot.hidden = this.kind !== 'terminal' || state.status === undefined;
    if (state.status !== undefined) {
      this.dot.className = `status-dot ${state.status}`;
      this.dot.title = state.status;
    }
    this.title.textContent = state.title;
    this.title.title = state.path;
  }

  private onPointerDown(down: PointerEvent): void {
    if (down.button !== 0 || (down.target as HTMLElement).closest('button')) return;
    const { clientX: x0, clientY: y0, pointerId } = down;

    const stop = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < DRAG_THRESHOLD_PX) return;
      stop();
      this.hooks.onDragStart(e);
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerId === pointerId) stop();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onEnd, true);
  }
}
