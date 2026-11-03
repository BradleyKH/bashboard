// Pure helpers for the setup wizard (docs/design.md section 4.17).

import { ACCENT_PRESETS, DEFAULT_ACCENT } from './accent';
import { lastFolder } from './dashboardModel';
import type { Editor } from './editors';
import { samePath, type Favorite } from './favorites';
import { SCRIM_PRESETS } from './scrim';
import type { BackdropStyle } from './settings';
import { isIntegrationShell, type ShellIntegrationStatus } from './shellIntegration';

export type SetupStep = 'git' | 'shell' | 'shellIntegration' | 'editor' | 'favorites' | 'claude' | 'look';

export interface SetupStepOptions {
  claudeDetected: boolean;
  hooksInstalled: boolean;
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
 * the default shell takes the lines (not cmd) and they are not current, Claude Code only when
 * detected without the hooks.
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
  if (opts.claudeDetected && !opts.hooksInstalled) steps.push('claude');
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
