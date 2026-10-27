// Pure helpers for the setup wizard (docs/design.md section 4.17).

import { lastFolder } from './dashboardModel';
import type { Editor } from './editors';
import { samePath, type Favorite } from './favorites';
import { SCRIM_PRESETS } from './scrim';

export type SetupStep = 'shell' | 'editor' | 'favorites' | 'claude' | 'look';

export interface Choice {
  value: string;
  label: string;
}

const DEFAULT_EDITOR: Choice = { value: 'default', label: "The file's default app" };

/** The steps to show, in order; Claude Code only when it is detected and the hooks are missing. */
export function setupSteps(opts: { claudeDetected: boolean; hooksInstalled: boolean }): SetupStep[] {
  const steps: SetupStep[] = ['shell', 'editor', 'favorites'];
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
