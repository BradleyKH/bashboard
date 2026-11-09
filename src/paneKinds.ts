// Pane kinds (docs/design/workspace.md section 4.11). Pure data, no DOM.

export type PaneKind = 'terminal' | 'scratch' | 'files' | 'git' | 'ship' | 'search' | 'containers' | 'ports' | 'browser';

export interface PaneKindInfo {
  kind: PaneKind;
  label: string;
  /** Shown by the kind menu and the dashboard's pane cards. */
  icon: string;
  /** False for kinds with no working folder, which take one from elsewhere when replaced. */
  hasFolder: boolean;
}

/** In kind menu order: Terminal, then the rest alphabetical by label. */
export const PANE_KINDS: readonly PaneKindInfo[] = [
  { kind: 'terminal', label: 'Terminal', icon: '❯', hasFolder: true },
  { kind: 'containers', label: 'Containers', icon: '⬡', hasFolder: false },
  { kind: 'files', label: 'Files', icon: '🗀', hasFolder: true },
  { kind: 'git', label: 'Git', icon: '⎇', hasFolder: true },
  // U+FE0E keeps the globe a text glyph rather than a color emoji.
  { kind: 'browser', label: 'Local Browser', icon: '\u{1F310}︎', hasFolder: false },
  { kind: 'ports', label: 'Ports', icon: '⇄', hasFolder: false },
  { kind: 'scratch', label: 'Scratch', icon: '▤', hasFolder: false },
  { kind: 'search', label: 'Search', icon: '⌕', hasFolder: true },
  // U+FE0E asks for the text glyph; without it WebView2 draws the color emoji rocket.
  { kind: 'ship', label: 'Ship', icon: '\u{1F680}︎', hasFolder: true },
];

export function paneKindInfo(kind: PaneKind): PaneKindInfo {
  return PANE_KINDS.find((k) => k.kind === kind)!;
}
