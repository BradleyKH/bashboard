import type { CloudChip } from './cloudContextModel';
import { attachContextMenu } from './contextMenu';
import { item, separator, submenu, type MenuEntry, type MenuLeaf } from './contextMenuModel';
import { setHintedTitle } from './keyHints';
import { kindMenu, kindMenuItems } from './kindMenu';
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
  /** A terminal's New pin; the menu leaves the item out without it. */
  onNewPin?(): void;
  /** Fired once the pointer has moved past the drag threshold; `e` is the move event that crossed it. */
  onDragStart(e: PointerEvent): void;
}

export interface TitleStripState {
  title: string;
  path: string;
  /** Shown as the status dot for terminals; other kinds omit it. */
  status?: TerminalStatus;
  /** What a waiting session is waiting on; the dot's tooltip while the status is waiting. */
  reason?: string;
  /** Cloud-context chips, terminals only (docs/design/terminal.md section 4.25). */
  cloud?: CloudChip[];
}

export interface TitleStripZoomState {
  /** Two or more expanded panes in the tab; otherwise the button is hidden. */
  available: boolean;
  zoomed: boolean;
  /**
   * A hidden pane in the zoomed tab is marked for attention (docs/design/workspace.md section 4.2).
   */
  attention: boolean;
}

const DRAG_THRESHOLD_PX = 4;

/** The title strip's right-click menu (docs/design/terminal.md section 4.4). */
export function titleStripMenuItems(
  state: { kindItems: MenuLeaf[]; zoom: TitleStripZoomState },
  hooks: Pick<TitleStripHooks, 'onCollapse' | 'onClose' | 'onZoom' | 'onNewPin'>,
): MenuEntry[] {
  const entries: MenuEntry[] = [
    submenu('Change kind', state.kindItems),
    item('Collapse', () => hooks.onCollapse()),
  ];
  if (state.zoom.available) entries.push(item(state.zoom.zoomed ? 'Restore' : 'Zoom', () => hooks.onZoom?.()));
  const { onNewPin } = hooks;
  if (onNewPin) entries.push(item('New pin', () => onNewPin()));
  entries.push(separator(), item('Close pane', () => hooks.onClose()));
  return entries;
}

/**
 * The per-pane title bar: kind button, status dot, title, the pane's own action buttons, then
 * collapse, zoom, and close (docs/design/terminal.md section 4.4).
 */
export class TitleStrip {
  readonly el: HTMLElement;
  private readonly kindButton: HTMLButtonElement;
  private readonly dot: HTMLElement;
  private readonly title: HTMLElement;
  private readonly actions: HTMLElement;
  /** Inside `actions`, ahead of the pane's own buttons; `setActions` leaves it alone. */
  private readonly cloud: HTMLElement;
  private readonly actionSlot: HTMLElement;
  private cloudKey = '';
  private readonly zoomButton: HTMLButtonElement;
  private kind: PaneKind;
  private zoom: TitleStripZoomState = { available: false, zoomed: false, attention: false };

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

    // Always present: it is the spacer that holds collapse, zoom, and close at the right edge.
    this.actions = document.createElement('div');
    this.actions.className = 'strip-actions';
    this.cloud = document.createElement('div');
    this.cloud.className = 'strip-clouds';
    this.actionSlot = document.createElement('div');
    this.actionSlot.className = 'strip-action-slot';
    this.actions.append(this.cloud, this.actionSlot);

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
    setHintedTitle(close, 'Close pane', 'closePane');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.onClose();
    });

    this.el.append(this.kindButton, this.dot, this.title, this.actions, collapse, this.zoomButton, close);

    // Keeps focus in xterm; pointer events and click handlers are unaffected.
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    attachContextMenu(this.el, () => ({
      entries: titleStripMenuItems(
        { kindItems: kindMenuItems(this.kind, (k) => this.hooks.onChooseKind?.(k)), zoom: this.zoom },
        this.hooks,
      ),
      target: this.el,
    }));
  }

  setKind(kind: PaneKind): void {
    this.kind = kind;
    const info = paneKindInfo(kind);
    this.kindButton.textContent = info.icon;
    this.kindButton.title = `${info.label}, change pane kind`;
  }

  /** Shows a pane kind's own buttons after the title; null clears them. */
  setActions(el: HTMLElement | null): void {
    this.actionSlot.replaceChildren(...(el ? [el] : []));
  }

  setZoom(state: TitleStripZoomState): void {
    this.zoom = state;
    this.zoomButton.hidden = !state.available;
    this.zoomButton.classList.toggle('zoomed', state.zoomed);
    this.zoomButton.classList.toggle('attention', state.attention);
    this.zoomButton.textContent = state.zoomed ? '⧉' : '⤢';
    setHintedTitle(this.zoomButton, state.zoomed ? 'Restore panes' : 'Zoom pane', 'togglePaneZoom');
  }

  update(state: TitleStripState): void {
    this.dot.hidden = this.kind !== 'terminal' || state.status === undefined;
    if (state.status !== undefined) {
      this.dot.className = `status-dot ${state.status}`;
      this.dot.title = state.status === 'waiting' && state.reason ? state.reason : state.status;
    }
    this.title.textContent = state.title;
    this.title.title = state.path;
    this.setCloud(this.kind === 'terminal' ? (state.cloud ?? []) : []);
  }

  private setCloud(chips: CloudChip[]): void {
    // Strips refresh on every status tick, so the chips are rebuilt only when they change.
    const key = chips.length === 0 ? '' : JSON.stringify(chips);
    if (key === this.cloudKey) return;
    this.cloudKey = key;
    this.cloud.replaceChildren(
      ...chips.map((c) => {
        const el = document.createElement('span');
        el.className = c.production ? 'strip-cloud production' : 'strip-cloud';
        el.textContent = c.text;
        el.title = c.title;
        return el;
      }),
    );
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
