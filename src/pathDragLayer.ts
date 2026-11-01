import './pathDrag.css';

export interface PathDrag {
  paths: string[];
  /**
   * Set when the paths are files dragged out of a Files pane: a folder target then moves them,
   * through that pane, out of `folder`.
   */
  move?: { paneId: string; folder: string };
}

/** A terminal or scratch pad takes the paths as text; a folder takes a movable drag's files. */
export type PathDropTarget =
  | { kind: 'insert'; paneId: string }
  | { kind: 'move'; folder: string; el: HTMLElement };

export function sameDropTarget(a: PathDropTarget | null, b: PathDropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'insert') return b.kind === 'insert' && a.paneId === b.paneId;
  return b.kind === 'move' && a.el === b.el && a.folder === b.folder;
}

export interface PathDragHooks {
  /** Where a drop at the point would land, or null when nothing there accepts this drag. */
  targetAt(x: number, y: number, drag: PathDrag): PathDropTarget | null;
  highlight(target: PathDropTarget | null): void;
  /** Pointer position on every tracked move; `null` when the drag ends. */
  onHover(pos: { x: number; y: number } | null): void;
  onDrop(target: PathDropTarget, drag: PathDrag): void;
  onCancel(): void;
}

function lastSegment(p: string): string {
  const segments = p.split(/[\\/]/).filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : p;
}

/** The ghost text: the first path's last segment, plus ` +N` for the rest. */
export function pathDragLabel(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const name = lastSegment(paths[0]);
  return paths.length > 1 ? `${name} +${paths.length - 1}` : name;
}

/** The ghost over a folder target says where the files will go. */
export function moveDragLabel(paths: readonly string[], folder: string): string {
  return `Move to ${lastSegment(folder)}: ${pathDragLabel(paths)}`;
}

/**
 * Pointer-driven drag layer for dragging file paths onto terminals, or files onto folders;
 * never HTML5 drag and drop.
 */
export class PathDragLayer {
  private active: (() => void) | null = null;

  constructor(private readonly hooks: PathDragHooks) {}

  isActive(): boolean {
    return this.active !== null;
  }

  begin(e: PointerEvent, drag: PathDrag): void {
    const { paths } = drag;
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
      const target = this.hooks.targetAt(x, y, drag);
      ghost.textContent = target?.kind === 'move' ? moveDragLabel(paths, target.folder) : pathDragLabel(paths);
      this.hooks.highlight(target);
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
      const target = this.hooks.targetAt(ev.clientX, ev.clientY, drag);
      cleanup();
      suppressNextClick();
      if (target) this.hooks.onDrop(target, drag);
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
