// Pure helpers for the setup wizard (docs/design.md section 4.17).

import { lastFolder } from './dashboardModel';
import type { Editor } from './editors';
import { samePath, type Favorite } from './favorites';
import { SCRIM_PRESETS } from './scrim';
import type { ShellIntegrationStatus } from './shellIntegration';

export type SetupStep = 'git' | 'shell' | 'shellIntegration' | 'editor' | 'favorites' | 'claude' | 'look';

export interface SetupStepOptions {
  claudeDetected: boolean;
  hooksInstalled: boolean;
  /** Whether Git Bash was found when the wizard opened. */
  gitBashFound: boolean;
  /** Set once Git is installed from the wizard, which keeps the Git step listed. */
  gitInstalled?: boolean;
  /** Null when the `.bashrc` state could not be read, which hides that step. */
  shellIntegrationStatus: ShellIntegrationStatus | null;
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
 * The steps to show, in order: Git only when Git Bash was missing, shell integration only once Git
 * Bash is there and the lines are not current, Claude Code only when detected without the hooks.
 */
export function setupSteps(opts: SetupStepOptions): SetupStep[] {
  const steps: SetupStep[] = [];
  if (!opts.gitBashFound) steps.push('git');
  steps.push('shell');
  const hasBash = opts.gitBashFound || opts.gitInstalled === true;
  if (hasBash && opts.shellIntegrationStatus !== null && opts.shellIntegrationStatus !== 'installed') {
    steps.push('shellIntegration');
  }
  steps.push('editor', 'favorites');
  if (opts.claudeDetected && !opts.hooksInstalled) steps.push('claude');
  steps.push('look');
  return steps;
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
