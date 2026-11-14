// The first-run tour's steps and when each one is done (docs/design/app.md section 4.29). No DOM.
import type { PaneKind } from './paneKinds';

/** Something the user did that a step may be waiting for. */
export type TourSignal =
  | { type: 'action'; action: string }
  | { type: 'paneOpened'; kind: PaneKind }
  /** A Launch menu or button choice, which may reuse an open pane rather than open one. */
  | { type: 'launched'; kind: string }
  | { type: 'saved' }
  | { type: 'dialog'; tab: string };

export interface TourStep {
  title: string;
  /** `{action}` and `{action:direction}` stand for the live keys, as in the Help tab's tour. */
  text: string;
  /** Absent for a step that only reads, which Next moves past. */
  doneBy?: (signal: TourSignal) => boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: 'Split a pane',
    text: 'Press {splitRight} to open a new terminal beside this one. The other arrows split in their directions.',
    // A split with no room opens nothing, so the new pane, not the key, finishes the step.
    doneBy: (s) => s.type === 'paneOpened' && s.kind === 'terminal',
  },
  {
    title: 'Move between panes',
    text: 'Press {moveFocus:left} to move back to the first pane. The other arrows move the same way.',
    doneBy: (s) => s.type === 'action' && s.action === 'moveFocus',
  },
  {
    title: 'Launch other panes',
    text: 'Press {openLaunch}, then F, to open a Files pane. Launch opens every kind of pane: Git, code search, a scratch pad, and more.',
    doneBy: (s) =>
      ((s.type === 'paneOpened' || s.type === 'launched') && s.kind === 'files') ||
      (s.type === 'action' && s.action === 'openFiles'),
  },
  {
    title: 'Command palette',
    text: 'Press {openPalette} to search every pane, tab, favorite, layout, and action. Escape closes it.',
    doneBy: (s) => s.type === 'action' && s.action === 'openPalette',
  },
  {
    title: 'Save your setup',
    text: 'Press {openLayout} and choose + Save to keep these panes as a layout, or press {openFavorite} and choose + Add to make this folder a favorite. Both are in the dashboard too.',
    doneBy: (s) => s.type === 'saved',
  },
  {
    title: 'The dashboard',
    text: "The dashboard lists every pane and what needs you. A terminal whose agent is waiting pulses, and {nextAttention} jumps to it. {toggleDashboard} shows or hides the dashboard; right-click a section's header to choose which sections it shows.",
  },
  {
    title: 'Settings',
    text: "The dashboard's ⚙ button, or {openSettings}, opens Settings. {showHelp} opens Help, where you can take this tour again.",
    doneBy: (s) => s.type === 'dialog' && s.tab === 'settings',
  },
];

/** The step after `index` once `signal` arrives, or `index` when the signal does not finish it. */
export function advance(index: number, signal: TourSignal): number {
  const step = TOUR_STEPS[index];
  return step?.doneBy?.(signal) ? index + 1 : index;
}

/**
 * The panes the tour's close offer would close: those opened during the tour that are still open,
 * keeping one when every open pane is the tour's, since closing the last would close the window.
 */
export function panesToClose(openIds: readonly string[], createdIds: ReadonlySet<string>): string[] {
  const created = openIds.filter((id) => createdIds.has(id));
  return created.length === openIds.length ? created.slice(1) : created;
}
