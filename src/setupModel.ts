// Pure helpers for the setup wizard (docs/design.md section 4.17).

import { ACCENT_PRESETS, DEFAULT_ACCENT } from './accent';
import { lastFolder } from './dashboardModel';
import type { CodexTrust, HookInstallPreview } from './hookInstall';
import { hookAction } from './hookInstallModel';
import type { AgentId } from './savedWorkspace';
import type { Editor } from './editors';
import { samePath, type Favorite } from './favorites';
import { SCRIM_PRESETS } from './scrim';
import type { BackdropStyle } from './settings';
import { isIntegrationShell, type ShellIntegrationStatus } from './shellIntegration';

export type SetupStep = 'git' | 'shell' | 'shellIntegration' | 'editor' | 'favorites' | 'agents' | 'look';

export interface SetupStepOptions {
  /** The agents that have run on this machine, each with its hook state. */
  agents: AgentHooks[];
  /** Whether Git Bash was found when the wizard opened. */
  gitBashFound: boolean;
  /** Set once Git is installed from the wizard, which keeps the Git step listed. */
  gitInstalled?: boolean;
  /** The profile new panes open with (`effectiveProfile`); null when no shells were listed. */
  defaultShell: string | null;
  /**
   * That shell's integration state, 'loading' while it is read. Null when it could not be read,
   * which hides the step.
   */
  shellIntegrationStatus: ShellIntegrationStatus | 'loading' | null;
}

/** One detected agent's hook state. */
export interface AgentHooks {
  agent: AgentId;
  installed: boolean;
  /** Not installed, and only the hook script needs refreshing; buttons say Update. */
  update?: boolean;
  /** Codex only, once installed; null or absent otherwise. */
  trust?: CodexTrust | null;
}

/** The detected agents among `previews`, in order, with whether Bashboard's hooks are in. */
export function agentHooksFrom(previews: HookInstallPreview[]): AgentHooks[] {
  return previews.flatMap((p) => {
    const agent = p.agent ?? 'claude';
    if (!(p.detected ?? p.claudeDetected)) return [];
    const update = !p.alreadyInstalled && hookAction(p) === 'update';
    return [{ agent, installed: p.alreadyInstalled, update, trust: p.trust ?? null }];
  });
}

/** The wizard's element builders, shared with the step renderers in their own files. */
export interface SetupStepUi {
  note(text: string): HTMLElement;
  button(text: string, onClick: () => void): HTMLButtonElement;
}

export interface Choice {
  value: string;
  label: string;
}

const DEFAULT_EDITOR: Choice = { value: 'default', label: "The file's default app" };

/**
 * The steps to show, in order: Git only when Git Bash was missing, shell integration only when
 * the default shell takes the lines (not cmd) and they are not current, the agents step only when
 * a detected agent lacks the hooks.
 */
export function setupSteps(opts: SetupStepOptions): SetupStep[] {
  const steps: SetupStep[] = [];
  if (!opts.gitBashFound) steps.push('git');
  steps.push('shell');
  const shell = opts.defaultShell;
  const hasBash = opts.gitBashFound || opts.gitInstalled === true;
  if (
    shell !== null &&
    isIntegrationShell(shell) &&
    (shell !== 'gitBash' || hasBash) &&
    opts.shellIntegrationStatus !== null &&
    opts.shellIntegrationStatus !== 'installed'
  ) {
    steps.push('shellIntegration');
  }
  steps.push('editor', 'favorites');
  if (opts.agents.some((a) => !a.installed)) steps.push('agents');
  steps.push('look');
  return steps;
}

/**
 * The profile a new pane runs: the saved default when it is installed, else the first installed
 * one, matching `pick` in src-tauri/src/profiles.rs. Null for an empty list.
 */
export function effectiveProfile(saved: string, installed: string[]): string | null {
  return installed.includes(saved) ? saved : (installed[0] ?? null);
}

/** New favorites for the checked repo paths, without paths already favorited or repeated. */
export function favoritesToAdd(checkedPaths: string[], favorites: Favorite[]): Favorite[] {
  const out: Favorite[] = [];
  for (const path of checkedPaths) {
    if (favorites.some((f) => samePath(f.path, path))) continue;
    if (out.some((f) => samePath(f.path, path))) continue;
    out.push({ label: lastFolder(path) || path, path });
  }
  return out;
}

/**
 * Ship pins for the checked repo paths: those `pinnable` maps to a pin identity (`host/owner/name`),
 * skipping identities already pinned or repeated, as when two clones share one repo.
 */
export function pinsToAdd(
  checkedPaths: readonly string[],
  pinnable: ReadonlyMap<string, string>,
  isPinned: (repo: string) => boolean,
): { repo: string; root: string }[] {
  const out: { repo: string; root: string }[] = [];
  for (const root of checkedPaths) {
    const repo = pinnable.get(root);
    if (repo === undefined || isPinned(repo) || out.some((p) => p.repo === repo)) continue;
    out.push({ repo, root });
  }
  return out;
}

/** The preset whose opacity is exactly `opacity`; null for a custom value between presets. */
export function scrimPresetFor(opacity: number): keyof typeof SCRIM_PRESETS | null {
  const names = Object.keys(SCRIM_PRESETS) as (keyof typeof SCRIM_PRESETS)[];
  return names.find((n) => SCRIM_PRESETS[n] === opacity) ?? null;
}

/**
 * Radio choices for the detected editors. The default app is always offered, and a saved editor
 * that was not detected is listed first under its raw id, since the core names only installed editors.
 */
export function editorChoices(found: Editor[], saved: string): Choice[] {
  const choices: Choice[] = found.map((e) => ({ value: e.id, label: e.name }));
  if (!choices.some((c) => c.value === DEFAULT_EDITOR.value)) choices.push(DEFAULT_EDITOR);
  if (saved && !choices.some((c) => c.value === saved)) {
    choices.unshift({ value: saved, label: `${saved} (not found)` });
  }
  return choices;
}

function presetValue(presets: Choice[], label: string): string {
  const found = presets.find((p) => p.label === label);
  if (!found) throw new Error(`no ${label} preset`);
  return found.value;
}

/** The green preset the Matrix background pairs with, closest to its default rain color. */
export const MATRIX_ACCENT = presetValue(ACCENT_PRESETS, 'Green');

/** Whether the wizard switched the accent to green itself, so it may switch it back. */
export interface AutoColors {
  accent: boolean;
}

export type SettingSave = [path: string[], value: string];

const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The accent save that goes with picking a background. Matrix turns a still-default accent green,
 * and text in accent mode follows it; leaving Matrix puts the accent back only when the wizard
 * turned it green and it is still green, so a color the user picked is never overridden.
 */
export function backgroundColorSaves(
  style: BackdropStyle,
  accent: string,
  auto: AutoColors,
): { saves: SettingSave[]; auto: AutoColors } {
  if (style === 'matrix') {
    if (!sameColor(accent, DEFAULT_ACCENT)) return { saves: [], auto };
    return { saves: [[['accentColor'], MATRIX_ACCENT]], auto: { accent: true } };
  }
  const saves: SettingSave[] = auto.accent && sameColor(accent, MATRIX_ACCENT) ? [[['accentColor'], DEFAULT_ACCENT]] : [];
  return { saves, auto: { accent: false } };
}
