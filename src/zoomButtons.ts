import { accumulateWheel, stepZoom, zoomPercent, ZOOM_LEVELS } from './textZoom';
import { setTextZoom, type TextZoomKey } from './textZoomStore';

/** Pixels per line and per page for a wheel event that reports in lines or pages. */
const LINE_PX = 40;
const PAGE_PX = 800;

/**
 * A − and + button pair that steps a pane's zoom level; the titles show the current level. Ctrl+wheel
 * over `wheelTarget` steps it too. Each step is saved to workspace.json's `textZoom.<key>`, so the
 * next pane of that kind starts there; other open panes keep their own zoom.
 */
export class ZoomButtons {
  readonly el: HTMLElement;
  private readonly outBtn: HTMLButtonElement;
  private readonly inBtn: HTMLButtonElement;
  private zoom: number;
  private wheelAcc = 0;

  constructor(
    buttonClass: string,
    private readonly key: TextZoomKey,
    initial: number,
    private readonly apply: (zoom: number) => void,
    wheelTarget?: HTMLElement,
  ) {
    this.zoom = initial;
    this.el = document.createElement('span');
    this.el.className = 'zoom-buttons';
    this.outBtn = this.button(buttonClass, '−', () => this.step(-1));
    this.inBtn = this.button(buttonClass, '+', () => this.step(1));
    this.el.append(this.outBtn, this.inBtn);
    this.sync();
    apply(initial);
    // Not passive, so preventDefault keeps Ctrl+wheel from also scrolling the area.
    wheelTarget?.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? PAGE_PX : 1;
    const { dir, acc } = accumulateWheel(this.wheelAcc, e.deltaY * scale);
    this.wheelAcc = acc;
    if (dir !== 0) this.step(dir);
  }

  private step(dir: 1 | -1): void {
    const next = stepZoom(this.zoom, dir);
    if (next === this.zoom) return;
    this.zoom = next;
    this.sync();
    this.apply(next);
    setTextZoom(this.key, next);
  }

  private sync(): void {
    const at = zoomPercent(this.zoom);
    this.outBtn.title = `Zoom out (${at})`;
    this.inBtn.title = `Zoom in (${at})`;
    this.outBtn.disabled = this.zoom <= ZOOM_LEVELS[0];
    this.inBtn.disabled = this.zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  }

  private button(cls: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
}
