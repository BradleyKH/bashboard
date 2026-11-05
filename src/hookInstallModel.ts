import type { HookInstallPreview, HookScriptState } from './hookInstall';

export type HookAction = 'install' | 'update';

/**
 * `update` when the agent's hook config already has every entry and only the script needs
 * writing, so the dialog and buttons say "Update" rather than offering an install.
 */
export function hookAction(preview: Pick<HookInstallPreview, 'additions' | 'scriptState'>): HookAction {
  const nothingToAdd = Object.keys(preview.additions).length === 0;
  return nothingToAdd && preview.scriptState === 'outdated' ? 'update' : 'install';
}

/** "Install" or "Update", for titles and buttons. */
export function hookActionVerb(action: HookAction): string {
  return action === 'update' ? 'Update' : 'Install';
}

/** The dialog's lead-in for the script path, or null when install leaves the script alone. */
export function scriptLineLabel(state: HookScriptState): string | null {
  switch (state) {
    case 'missing':
      return 'Writes the hook script to';
    case 'outdated':
      return 'Updates the hook script at';
    case 'current':
    case 'newer':
      return null;
  }
}
