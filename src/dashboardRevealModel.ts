// Text for the dashboard's top-bar and edge-handle tooltips and the notice the × button shows
// (docs/design.md section 4.6).

import type { DashboardSide } from './dashboardResize';

/** A tooltip with the action's formatted chords in parentheses, or bare when none are bound. */
export function withKeys(title: string, keys: string | undefined): string {
  return keys ? `${title} (${keys})` : title;
}

/** The handle's tooltip; `keys` is the toggle's formatted chords, if any are bound. */
export function revealTitle(keys: string | undefined): string {
  return withKeys('Show the dashboard', keys);
}

/** The notice after the × button hides the panel, naming both ways back. */
export function hiddenNotice(keys: string | undefined, side: DashboardSide): string {
  const handle = `the handle on the window's ${side} edge`;
  return keys
    ? `Dashboard hidden. Press ${keys} or click ${handle} to bring it back.`
    : `Dashboard hidden. Click ${handle} to bring it back.`;
}
