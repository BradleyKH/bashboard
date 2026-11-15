/**
 * A thin horizontal slider driven by pointer events (docs/design/dashboard.md section 4.31). The
 * dashboard cancels mousedown so clicks never take focus from the terminal, which would also stop
 * a native range input from dragging; this one needs neither focus nor mousedown.
 */
export class MediaSlider {
  readonly el: HTMLElement;
  private readonly fillEl: HTMLElement;
  private fraction = 0;
  private dragging = false;
  private disabled = false;

  constructor(
    className: string,
    label: string,
    /** Every move while dragging. */
    private readonly onInput: (fraction: number) => void,
    /** Once, on release. */
    private readonly onCommit: (fraction: number) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = `media-slider ${className}`;
    this.el.setAttribute('role', 'slider');
    this.el.setAttribute('aria-label', label);
    this.el.setAttribute('aria-valuemin', '0');
    this.el.setAttribute('aria-valuemax', '100');
    this.fillEl = document.createElement('div');
    this.fillEl.className = 'media-slider-fill';
    this.el.append(this.fillEl);

    this.el.addEventListener('pointerdown', (e) => {
      if (this.disabled || e.button !== 0) return;
      this.dragging = true;
      this.el.classList.add('dragging');
      this.el.setPointerCapture(e.pointerId);
      this.move(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (this.dragging) this.move(e);
    });
    const end = (commit: boolean): void => {
      if (!this.dragging) return;
      this.dragging = false;
      this.el.classList.remove('dragging');
      if (commit) this.onCommit(this.fraction);
    };
    this.el.addEventListener('pointerup', () => end(true));
    this.el.addEventListener('pointercancel', () => end(false));
  }

  /** Shows `fraction` unless the user is dragging. */
  set(fraction: number): void {
    if (!this.dragging) this.show(fraction);
  }

  get held(): boolean {
    return this.dragging;
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    this.el.classList.toggle('disabled', disabled);
    this.el.setAttribute('aria-disabled', String(disabled));
  }

  private move(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    this.show(r.width > 0 ? (e.clientX - r.left) / r.width : 0);
    this.onInput(this.fraction);
  }

  private show(fraction: number): void {
    this.fraction = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    this.fillEl.style.width = `${(this.fraction * 100).toFixed(2)}%`;
    this.el.setAttribute('aria-valuenow', String(Math.round(this.fraction * 100)));
  }
}
