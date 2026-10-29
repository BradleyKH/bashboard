import { saveSetting, type Settings } from './settings';
import { stepZoom, zoomPercent, ZOOM_LEVELS } from './textZoom';
import { showToast } from './toast';

export type TextZoomKey = keyof Settings['textZoom'];

/**
 * A − and + button pair that steps a pane's zoom level; the titles show the current level. Each
 * step is saved to `textZoom.<key>`, so the next pane of that kind starts there; other open
 * panes keep their own zoom.
 */
export class ZoomButtons {
  readonly el: HTMLElement;
  private readonly outBtn: HTMLButtonElement;
  private readonly inBtn: HTMLButtonElement;
  private zoom: number;

  constructor(
    buttonClass: string,
    private readonly key: TextZoomKey,
    initial: number,
    private readonly apply: (zoom: number) => void,
  ) {
    this.zoom = initial;
    this.el = document.createElement('span');
    this.el.className = 'zoom-buttons';
    this.outBtn = this.button(buttonClass, '−', () => this.step(-1));
    this.inBtn = this.button(buttonClass, '+', () => this.step(1));
    this.el.append(this.outBtn, this.inBtn);
    this.sync();
    apply(initial);
  }

  private step(dir: 1 | -1): void {
    const next = stepZoom(this.zoom, dir);
    if (next === this.zoom) return;
    this.zoom = next;
    this.sync();
    this.apply(next);
    saveSetting(['textZoom', this.key], next).catch((err: unknown) =>
      showToast(`Could not save the zoom: ${String(err)}`),
    );
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
