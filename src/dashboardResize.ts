// The dashboard's drag-to-resize inner edge, the one facing the panes (docs/design.md section 4.6).

export type DashboardSide = 'left' | 'right';

export const DEFAULT_DASHBOARD_WIDTH = 300;
/** Wide enough that the Repo section's Terminal, Files, Git, Search, and Editor buttons stay on one row. */
export const MIN_DASHBOARD_WIDTH = 280;
/** The panel never takes more than this share of the window. */
const MAX_WINDOW_SHARE = 0.6;

/** Rounds `width` and clamps it between the minimum and a share of `windowWidth`. */
export function clampDashboardWidth(width: number, windowWidth: number): number {
  const max = Math.max(MIN_DASHBOARD_WIDTH, Math.floor(windowWidth * MAX_WINDOW_SHARE));
  return Math.min(max, Math.max(MIN_DASHBOARD_WIDTH, Math.round(width)));
}

/**
 * The width after the pointer moves from `startX` to `x`: moving away from the docked edge
 * (rightward when docked left, leftward when docked right) widens the panel.
 */
export function draggedWidth(
  startWidth: number,
  startX: number,
  x: number,
  side: DashboardSide,
  windowWidth: number,
): number {
  const delta = side === 'left' ? x - startX : startX - x;
  return clampDashboardWidth(startWidth + delta, windowWidth);
}

export function applyDashboardWidth(width: number): void {
  document.documentElement.style.setProperty('--dashboard-width', `${width}px`);
}

/**
 * Builds the handle. Dragging it sets the width live; `onCommit` fires once the drag ends with
 * the final width, so a save happens once per drag rather than per move.
 */
export function dashboardResizeHandle(
  getWidth: () => number,
  onCommit: (width: number) => void,
  getSide: () => DashboardSide = () => 'right',
): HTMLElement {
  const handle = document.createElement('div');
  handle.className = 'dashboard-resize';
  handle.title = 'Drag to resize the dashboard';
  handle.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const startX = down.clientX;
    const startWidth = getWidth();
    const side = getSide();
    let width = startWidth;
    handle.setPointerCapture(down.pointerId);
    document.body.classList.add('dashboard-resizing');
    const onMove = (move: PointerEvent) => {
      // The panel is anchored to its docked side, so the width follows the inner edge.
      width = draggedWidth(startWidth, startX, move.clientX, side, window.innerWidth);
      applyDashboardWidth(width);
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      document.body.classList.remove('dashboard-resizing');
      if (width !== startWidth) onCommit(width);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  });
  return handle;
}
