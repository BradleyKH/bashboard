// Pane kinds (docs/design.md section 4.11). Pure data, no DOM.

export type PaneKind = 'terminal' | 'scratch' | 'files' | 'git' | 'search' | 'containers';

export interface PaneKindInfo {
  kind: PaneKind;
  label: string;
  /** Shown by the kind menu and the dashboard's pane cards. */
  icon: string;
  /** False for kinds with no working folder, which take one from elsewhere when replaced. */
  hasFolder: boolean;
}

/** In kind menu order. */
export const PANE_KINDS: readonly PaneKindInfo[] = [
  { kind: 'terminal', label: 'Terminal', icon: '❯', hasFolder: true },
  { kind: 'files', label: 'Files', icon: '🗀', hasFolder: true },
  { kind: 'git', label: 'Git', icon: '⎇', hasFolder: true },
  { kind: 'search', label: 'Search', icon: '⌕', hasFolder: true },
  { kind: 'containers', label: 'Containers', icon: '⬡', hasFolder: false },
  { kind: 'scratch', label: 'Scratch', icon: '▤', hasFolder: false },
];

export function paneKindInfo(kind: PaneKind): PaneKindInfo {
  return PANE_KINDS.find((k) => k.kind === kind)!;
}
