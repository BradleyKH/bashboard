import type { GitInstallStatus } from './gitInstall';
import { agentName, isPreviewAgent } from './agentNames';
import type { HookInstallPreview } from './hookInstall';
import { hookAction } from './hookInstallModel';
import type { AgentId } from './savedWorkspace';
import type { IntegrationShell, ShellIntegrationPreview } from './shellIntegration';

export type StatusLevel = 'ok' | 'missing' | 'info';

export type StatusFix =
  | { kind: 'gitInstall' }
  | { kind: 'gitDownload' }
  | { kind: 'shell'; shell: IntegrationShell }
  | { kind: 'hooks'; agent: AgentId };

/** One line of the Help tab's setup status (docs/design/app.md section 4.18). */
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

/** One agent's hooks line; `preview` is null when the core could not be asked. */
export function hooksRow(agent: AgentId, preview: HookInstallPreview | null): StatusRow {
  const name = agentName(agent);
  const base = { id: `hooks:${agent}`, label: `${name} hooks${isPreviewAgent(agent) ? ' (preview)' : ''}` };
  if (!preview) return { ...base, level: 'info', text: 'Could not check' };
  if (preview.alreadyInstalled) {
    if (preview.trust === 'untrusted') {
      return { ...base, level: 'info', text: `Installed, not yet trusted; ${name} will ask to trust the hook on its next start` };
    }
    if (preview.trust === 'unknown') {
      return { ...base, level: 'info', text: `Installed; could not read ${name}'s config to confirm it trusts the hook` };
    }
    return { ...base, level: 'ok', text: 'Installed' };
  }
  if (!(preview.detected ?? preview.claudeDetected)) {
    return { ...base, level: 'info', text: `${name} has not run on this machine` };
  }
  if (hookAction(preview) === 'update') {
    return {
      ...base,
      level: 'missing',
      text: 'Out of date; Update brings the hook entries and hook program current',
      fix: { kind: 'hooks', agent, label: 'Update' },
    };
  }
  return {
    ...base,
    level: 'missing',
    text: `Not installed; terminals won't show when ${name} is waiting or done`,
    fix: { kind: 'hooks', agent, label: 'Install' },
  };
}
