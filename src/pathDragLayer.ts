import './pathDrag.css';

export interface PathDragHooks {
  /** The pane id a drop at the point would land on, or null when nothing there accepts paths. */
  targetAt(x: number, y: number): string | null;
  highlight(paneId: string | null): void;
  /** Pointer position on every tracked move; `null` when the drag ends. */
  onHover(pos: { x: number; y: number } | null): void;
  onDrop(paneId: string, paths: string[]): void;
  onCancel(): void;
}

/** The ghost text: the first path's last segment, plus ` +N` for the rest. */
export function pathDragLabel(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const segments = paths[0].split(/[\\/]/).filter((s) => s.length > 0);
  const name = segments.length > 0 ? segments[segments.length - 1] : paths[0];
  return paths.length > 1 ? `${name} +${paths.length - 1}` : name;
}

/** Pointer-driven drag layer for dragging file paths onto terminals; never HTML5 drag and drop. */
export class PathDragLayer {
  private active: (() => void) | null = null;

  constructor(private readonly hooks: PathDragHooks) {}

  isActive(): boolean {
    return this.active !== null;
  }

  begin(e: PointerEvent, paths: string[]): void {
    this.active?.();

    const layer = document.createElement('div');
    layer.className = 'path-drag-layer';
    layer.style.cssText = 'position:fixed;inset:0;z-index:1000;touch-action:none;cursor:grabbing;';

    const ghost = document.createElement('div');
    ghost.className = 'dock-ghost';
    ghost.textContent = pathDragLabel(paths);
    ghost.style.cssText = 'position:fixed;pointer-events:none;white-space:nowrap;';

    layer.append(ghost);
    document.body.append(layer);
    try {
      layer.setPointerCapture(e.pointerId);
    } catch {
      // The layer covers the window, so events still arrive without capture.
    }

    const track = (x: number, y: number) => {
      ghost.style.left = `${x + 12}px`;
      ghost.style.top = `${y + 12}px`;
      this.hooks.onHover({ x, y });
      this.hooks.highlight(this.hooks.targetAt(x, y));
    };

    const swallowClick = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    // A click can follow pointerup and must not reach whatever sat under the drag.
    const suppressNextClick = () => {
      const drop = () => {
        window.removeEventListener('click', swallowClick, true);
        window.removeEventListener('pointerdown', drop, true);
        clearTimeout(timer);
      };
      const timer = setTimeout(drop, 50);
      window.addEventListener('click', swallowClick, true);
      window.addEventListener('pointerdown', drop, true);
    };

    const cleanup = () => {
      layer.removeEventListener('pointermove', onMove);
      layer.removeEventListener('pointerup', onUp);
      layer.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      layer.remove();
      this.active = null;
      this.hooks.highlight(null);
      this.hooks.onHover(null);
    };

    const onMove = (ev: PointerEvent) => track(ev.clientX, ev.clientY);
    const onUp = (ev: PointerEvent) => {
      // The layer is still mounted here; targetAt skips it.
      const target = this.hooks.targetAt(ev.clientX, ev.clientY);
      cleanup();
      suppressNextClick();
      if (target) this.hooks.onDrop(target, paths);
      else this.hooks.onCancel();
    };
    const onCancel = () => {
      cleanup();
      this.hooks.onCancel();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      onCancel();
    };

    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerup', onUp);
    layer.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    this.active = cleanup;
    track(e.clientX, e.clientY);
  }
}
