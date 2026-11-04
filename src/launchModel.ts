// The Launch options (docs/design.md section 4.6), shared by the Launch section, the top bar's
// + menu, and the openLaunch menu. Pure, no DOM.

import { item, type MenuItem } from './contextMenuModel';
import { paneKindInfo, type PaneKind } from './paneKinds';

export type LaunchKind = 'terminal' | 'files' | 'git' | 'search' | 'scratch' | 'editor';

export interface LaunchOption {
  kind: LaunchKind;
  label: string;
  icon: string;
  /** The letter that chooses it in the launch menu. */
  key: string;
  /** Tooltip text, before any key hint. */
  title: string;
  /** The keymap action that opens the same thing at the same root, if one does. */
  action?: string;
}

// Terminal names no action: splitAuto opens at the focused pane's folder, which can be below the
// repo root the Launch terminal opens at.
const OPTIONS: readonly LaunchOption[] = [
  { kind: 'terminal', label: 'Terminal', icon: paneKindInfo('terminal').icon, key: 't', title: 'Terminal at the repo root' },
  { kind: 'files', label: 'Files', icon: paneKindInfo('files').icon, key: 'f', title: 'Files at the repo root', action: 'openFiles' },
  { kind: 'git', label: 'Git', icon: paneKindInfo('git').icon, key: 'g', title: 'Git pane for the repo', action: 'openGit' },
  { kind: 'search', label: 'Search', icon: paneKindInfo('search').icon, key: 's', title: 'Search the repo\'s code', action: 'openSearch' },
  { kind: 'scratch', label: 'Scratch', icon: paneKindInfo('scratch').icon, key: 'p', title: 'Scratch pad', action: 'newScratch' },
  { kind: 'editor', label: 'Editor', icon: '✎', key: 'e', title: 'Open the repo in the editor', action: 'openEditor' },
];

/** The options in display order; Git only for a git repo. */
export function launchOptions(isGit: boolean): LaunchOption[] {
  return OPTIONS.filter((o) => o.kind !== 'git' || isGit);
}

/** Whether the option opens a pane, which the launch preview can show; the editor is its own window. */
export function opensPane(kind: LaunchKind): kind is LaunchKind & PaneKind {
  return kind !== 'editor';
}

export function launchLabel(kind: LaunchKind): string {
  return OPTIONS.find((o) => o.kind === kind)!.label;
}

/** The launch menu's entries: each option with its icon and letter, previewed as it is highlighted. */
export function launchMenuItems(
  isGit: boolean,
  onLaunch: (kind: LaunchKind) => void,
  onPreview: (kind: LaunchKind) => void,
): MenuItem[] {
  return launchOptions(isGit).map((o) =>
    item(o.label, () => onLaunch(o.kind), { icon: o.icon, key: o.key, onHighlight: () => onPreview(o.kind) }),
  );
}
