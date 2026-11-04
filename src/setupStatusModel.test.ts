import { describe, expect, it } from 'vitest';
import { gitRow, hooksRow, shellRow } from './setupStatusModel';
import type { HookInstallPreview } from './hookInstall';
import type { ShellIntegrationPreview } from './shellIntegration';

const preview = (over: Partial<ShellIntegrationPreview>): ShellIntegrationPreview => ({
  shell: 'gitBash',
  path: '~/.bashrc',
  status: 'missing',
  block: '',
  createsFile: false,
  createsBashProfile: false,
  warning: null,
  ...over,
});

const hooks = (over: Partial<HookInstallPreview>): HookInstallPreview => ({
  settingsPath: '',
  scriptPath: '',
  additions: {},
  alreadyInstalled: false,
  claudeDetected: true,
  bashFound: true,
  ...over,
});

describe('gitRow', () => {
  it('offers winget when it is present, else the download page', () => {
    expect(gitRow({ gitBashFound: false, wingetFound: true }).fix?.kind).toBe('gitInstall');
    expect(gitRow({ gitBashFound: false, wingetFound: false }).fix?.kind).toBe('gitDownload');
  });

  it('is ok when found, and unknown without an answer', () => {
    expect(gitRow({ gitBashFound: true, wingetFound: false })).toMatchObject({ level: 'ok' });
    expect(gitRow({ gitBashFound: true, wingetFound: false }).fix).toBeUndefined();
    expect(gitRow(null).level).toBe('info');
  });
});

describe('shellRow', () => {
  it('offers an install or update when the lines are missing or old', () => {
    expect(shellRow('gitBash', 'Git Bash', preview({ status: 'missing' }), true).fix).toEqual({ kind: 'shell', shell: 'gitBash', label: 'Install' });
    expect(shellRow('pwsh', 'PowerShell 7', preview({ status: 'outdated' }), true).fix?.label).toBe('Update');
  });

  it('has no fix for installed, hand-added, or customized lines', () => {
    for (const status of ['installed', 'handAdded', 'custom'] as const) {
      expect(shellRow('gitBash', 'Git Bash', preview({ status }), true).fix).toBeUndefined();
    }
  });

  it('keeps a warning in the text and downgrades ok to info', () => {
    const row = shellRow('gitBash', 'Git Bash', preview({ status: 'installed', warning: 'No ~/.bash_profile.' }), true);
    expect(row.level).toBe('info');
    expect(row.text).toContain('No ~/.bash_profile.');
  });

  it('warns only for the default shell, but offers the install for every shell', () => {
    expect(shellRow('pwsh', 'PowerShell 7', preview({ status: 'missing' }), true).level).toBe('missing');
    const other = shellRow('pwsh', 'PowerShell 7', preview({ status: 'missing' }), false);
    expect(other.level).toBe('info');
    expect(other.fix?.label).toBe('Install');
  });

  it('shows a rejection message', () => {
    expect(shellRow('gitBash', 'Git Bash', 'cannot read', true)).toMatchObject({ level: 'info', text: 'cannot read' });
  });
});

describe('hooksRow', () => {
  it('offers the install only when Claude Code has run', () => {
    expect(hooksRow(hooks({})).fix?.kind).toBe('hooks');
    expect(hooksRow(hooks({ claudeDetected: false })).fix).toBeUndefined();
    expect(hooksRow(hooks({ alreadyInstalled: true })).level).toBe('ok');
  });
});
