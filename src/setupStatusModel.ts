import type { GitInstallStatus } from './gitInstall';
import type { HookInstallPreview } from './hookInstall';
import type { IntegrationShell, ShellIntegrationPreview } from './shellIntegration';

export type StatusLevel = 'ok' | 'missing' | 'info';

export type StatusFix =
  | { kind: 'gitInstall' }
  | { kind: 'gitDownload' }
  | { kind: 'shell'; shell: IntegrationShell }
  | { kind: 'hooks' };

/** One line of the Help tab's setup status (docs/design.md section 4.18). */
export interface StatusRow {
  id: string;
  label: string;
  level: StatusLevel;
  text: string;
  fix?: StatusFix & { label: string };
}

export function gitRow(status: GitInstallStatus | null): StatusRow {
  const base = { id: 'git', label: 'Git Bash' };
  if (!status) return { ...base, level: 'info', text: 'Could not check' };
  if (status.gitBashFound) return { ...base, level: 'ok', text: 'Installed' };
  return {
    ...base,
    level: 'missing',
    text: 'Not found; Git Bash panes and the Git pane need it',
    fix: status.wingetFound ? { kind: 'gitInstall', label: 'Install' } : { kind: 'gitDownload', label: 'Download' },
  };
}

/**
 * `preview` is the core's answer, or the message it rejected with. Only the default shell's
 * missing lines are a warning; the others are offered without one.
 */
export function shellRow(
  shell: IntegrationShell,
  name: string,
  preview: ShellIntegrationPreview | string,
  isDefault: boolean,
): StatusRow {
  const base = { id: `shell:${shell}`, label: `${name} integration` };
  if (typeof preview === 'string') return { ...base, level: 'info', text: preview };
  const warning = preview.warning ? ` ${preview.warning}` : '';
  const needed: StatusLevel = isDefault ? 'missing' : 'info';
  switch (preview.status) {
    case 'installed':
      return { ...base, level: preview.warning ? 'info' : 'ok', text: `Installed in ${preview.path}.${warning}` };
    case 'handAdded':
      return { ...base, level: preview.warning ? 'info' : 'ok', text: `Added by hand in ${preview.path}.${warning}` };
    case 'custom':
      return { ...base, level: 'info', text: `Customized in ${preview.path}; update it by hand.${warning}` };
    case 'outdated':
      return {
        ...base,
        level: needed,
        text: `Out of date in ${preview.path}.${warning}`,
        fix: { kind: 'shell', shell, label: 'Update' },
      };
    case 'missing':
      return {
        ...base,
        level: needed,
        text: isDefault
          ? `Not set up; new panes won't open in the current folder. Adds lines to ${preview.path}.${warning}`
          : `Not set up. Adds lines to ${preview.path}.${warning}`,
        fix: { kind: 'shell', shell, label: 'Install' },
      };
  }
}

export function hooksRow(preview: HookInstallPreview | null): StatusRow {
  const base = { id: 'hooks', label: 'Claude Code hooks' };
  if (!preview) return { ...base, level: 'info', text: 'Could not check' };
  if (preview.alreadyInstalled) return { ...base, level: 'ok', text: 'Installed' };
  if (!preview.claudeDetected) return { ...base, level: 'info', text: 'Claude Code has not run on this machine' };
  return {
    ...base,
    level: 'missing',
    text: "Not installed; terminals won't show when Claude is waiting or done",
    fix: { kind: 'hooks', label: 'Install' },
  };
}
