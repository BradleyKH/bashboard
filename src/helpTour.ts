import { chordHint } from './paletteModel';
import type { Direction, KeybindingEntry } from './keymap';
import { primaryName } from './platform';

/** One run of a tour paragraph: plain text, or the live keys of an action. */
export type TourPart = { text: string } | { keys: string[] } | { unbound: string };

export interface TourSection {
  title: string;
  paragraphs: TourPart[][];
}

/**
 * The Help tab's short tour of docs/user-guide.md. `{action}` or `{action:direction}` stands for
 * the keys bound to that action, read from the live keymap so overrides show. "Mod" is the OS's
 * command modifier: Cmd on macOS, Ctrl elsewhere.
 */
const TOUR: { title: string; paragraphs: string[] }[] = [
  {
    title: 'Panes and tabs',
    paragraphs: [
      'Split the focused pane with {splitRight} or {splitDown}, move between panes with {moveFocus:left} and the other arrows, and close one with {closePane}. {togglePaneZoom} zooms a pane to fill its tab; {collapsePane} collapses it to a card on the dashboard.',
      'Tabs each hold their own panes: {newTab} opens one, {nextTab} and {prevTab} move between them, and {closeTab} closes the current one. Drag a pane by its title strip to dock it elsewhere, or onto another tab.',
    ],
  },
  {
    title: 'Pane kinds',
    paragraphs: [
      "Besides terminals, a pane can be a scratch pad ({newScratch}), a Files browser ({openFiles}), a Git pane ({openGit}), a code search ({openSearch}), a Containers view, or a Ports list of listening dev servers. The kind menu at the left of every title strip turns a pane into another kind in place, and Launch ({openLaunch}) opens any of them.",
    ],
  },
  {
    title: 'Dashboard',
    paragraphs: [
      '{toggleDashboard} shows or hides the dashboard. It lists every pane with its status, plus what needs you (waiting and failed terminals, pull requests to review or fix, failed builds), your favorite folders, layouts, the focused repo\'s pins, containers, listening ports, and Ship. Right-click an empty spot or a section header to choose which sections it shows. {focusDashboard} moves focus into it, where the arrow keys move between rows.',
      'Favorites ({openFavorite}) open a folder as a split; layouts ({openLayout}) restore a saved arrangement of panes.',
    ],
  },
  {
    title: 'Attention',
    paragraphs: [
      'A terminal that is waiting for you, or whose agent session finished, pulses or shows a green check mark on its pane, card, and tab. {nextAttention} jumps to the next thing that needs you, across all tabs.',
    ],
  },
  {
    title: 'Finding things',
    paragraphs: [
      '{openPalette} opens the command palette over panes, tabs, favorites, layouts, and every action. {find} searches the focused terminal\'s scrollback, and Mod+click opens a link in the output.',
    ],
  },
  {
    title: 'Look',
    paragraphs: [
      '{cycleScrim} dims the backdrop behind the panes, and {toggleBackdrop} pauses its animation. {increaseFontSize} and {decreaseFontSize} change the text size of terminals and pane content. The Settings tab has the rest.',
    ],
  },
];

const TOKEN = /\{(\w+)(?::(\w+))?\}/g;

function keysOf(entries: KeybindingEntry[], action: string, direction?: string): TourPart {
  const hint = chordHint(entries, action, direction as Direction | undefined);
  return hint ? { keys: hint.split(', ') } : { unbound: action };
}

/** Splits one paragraph's text into parts, resolving each token to its live keys. */
export function tourParagraph(text: string, entries: KeybindingEntry[]): TourPart[] {
  const parts: TourPart[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    parts.push(keysOf(entries, m[1], m[2]));
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

export function tourSections(entries: KeybindingEntry[]): TourSection[] {
  const mod = primaryName();
  return TOUR.map((s) => ({
    title: s.title,
    paragraphs: s.paragraphs.map((p) => tourParagraph(p.split('Mod+').join(`${mod}+`), entries)),
  }));
}

/** Every `{action}` the tour names, for checking it against the keymap's action list. */
export function tourActions(): string[] {
  return TOUR.flatMap((s) => s.paragraphs.flatMap((p) => [...p.matchAll(TOKEN)].map((m) => m[1])));
}
