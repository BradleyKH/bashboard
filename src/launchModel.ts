// The Launch options (docs/design/dashboard.md section 4.6), shared by the Launch section, the top
// bar's + menu, and the openLaunch menu. Pure, no DOM.

import { agentName } from './agentNames';
import { item, submenu, type MenuEntry } from './contextMenuModel';
import { paneKindInfo, type PaneKind } from './paneKinds';
import { safeModel, type AgentId } from './savedWorkspace';

export type LaunchKind = Extract<PaneKind, 'terminal' | 'git' | 'files' | 'ship' | 'search' | 'containers' | 'ports' | 'browser' | 'scratch'>;

/** Kinds with no folder: they open as they are, not at the launch root. */
export type FolderlessLaunchKind = Extract<LaunchKind, 'containers' | 'ports' | 'browser' | 'scratch'>;

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
  /** Offered by the launch menu only; the dashboard's row is for the repo's own panes. */
  menuOnly?: boolean;
}

// Kind menu order (4.11). Terminal names no action: splitAuto opens at the focused pane's folder,
// which can be below the repo root the Launch terminal opens at.
const OPTIONS: readonly LaunchOption[] = [
  { kind: 'terminal', label: 'Terminal', icon: paneKindInfo('terminal').icon, key: 't', title: 'Terminal at the repo root' },
  { kind: 'containers', label: 'Containers', icon: paneKindInfo('containers').icon, key: 'c', title: 'Docker and Podman containers', menuOnly: true },
  { kind: 'files', label: 'Files', icon: paneKindInfo('files').icon, key: 'f', title: 'Files at the repo root', action: 'openFiles' },
  { kind: 'git', label: 'Git', icon: paneKindInfo('git').icon, key: 'g', title: 'Git pane for the repo', action: 'openGit' },
  { kind: 'browser', label: 'Local Browser', icon: paneKindInfo('browser').icon, key: 'b', title: 'Browse a local dev server', menuOnly: true },
  { kind: 'ports', label: 'Ports', icon: paneKindInfo('ports').icon, key: 'r', title: 'Listening dev servers', menuOnly: true },
  { kind: 'scratch', label: 'Scratch', icon: paneKindInfo('scratch').icon, key: 'p', title: 'Scratch pad', action: 'newScratch' },
  { kind: 'search', label: 'Search', icon: paneKindInfo('search').icon, key: 's', title: 'Search the repo\'s code', action: 'openSearch' },
  { kind: 'ship', label: 'Ship', icon: paneKindInfo('ship').icon, key: 'o', title: 'Pipelines and pull requests for the repo' },
];

/** Git and Ship need a repo, so a folder that is not one leaves them out. */
const NEEDS_GIT: ReadonlySet<LaunchKind> = new Set(['git', 'ship']);

/** The dashboard row's options in display order; Git and Ship only for a git repo. */
export function launchOptions(isGit: boolean): LaunchOption[] {
  return OPTIONS.filter((o) => !o.menuOnly && (isGit || !NEEDS_GIT.has(o.kind)));
}

/** What decides the launch menu's entries. */
export interface LaunchContext {
  isGit: boolean;
  /** False while no container engine is installed, which leaves Containers out as the kind menu does. */
  containers: boolean;
  /** False on an OS without the Local Browser, which leaves it out as the kind menu does. */
  localBrowser?: boolean;
}

/** The launch menu's options in display order: the row's, plus Containers and Ports. */
export function launchMenuOptions(ctx: LaunchContext): LaunchOption[] {
  return OPTIONS.filter(
    (o) =>
      (ctx.isGit || !NEEDS_GIT.has(o.kind)) &&
      (ctx.containers || o.kind !== 'containers') &&
      (ctx.localBrowser !== false || o.kind !== 'browser'),
  );
}

export function isFolderless(kind: LaunchKind): kind is FolderlessLaunchKind {
  return kind === 'containers' || kind === 'ports' || kind === 'browser' || kind === 'scratch';
}

export function launchLabel(kind: LaunchKind): string {
  return OPTIONS.find((o) => o.kind === kind)!.label;
}

/** What the local-model entries need: the installed models and the agents to offer them for. */
export interface LocalLaunch {
  agents: AgentId[];
  models: string[];
  /** Opens a terminal running the command at the launch root. */
  onRun: (command: string) => void;
}

/** The command that starts `agent` on an Ollama model, or null when the name is unsafe to type. */
export function ollamaLaunchCommand(agent: AgentId, model: string): string | null {
  const safe = safeModel(model);
  return safe ? `ollama launch ${agent} --model ${safe}` : null;
}

/** The launch menu's entries: each option with its icon and letter, previewed as it is highlighted. */
export function launchMenuItems(
  ctx: LaunchContext,
  onLaunch: (kind: LaunchKind) => void,
  onPreview: (kind: LaunchKind) => void,
  local?: LocalLaunch,
): MenuEntry[] {
  const entries: MenuEntry[] = launchMenuOptions(ctx).map((o) =>
    item(o.label, () => onLaunch(o.kind), { icon: o.icon, key: o.key, onHighlight: () => onPreview(o.kind) }),
  );
  if (!local || local.models.length === 0) return entries;
  for (const agent of local.agents) {
    const leaves = local.models.flatMap((model) => {
      const command = ollamaLaunchCommand(agent, model);
      return command ? [item(model, () => local.onRun(command))] : [];
    });
    if (leaves.length > 0) entries.push(submenu(`${agentName(agent)} on a local model`, leaves));
  }
  return entries;
}
