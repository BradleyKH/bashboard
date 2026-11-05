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
  scriptState: 'missing',
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
    expect(hooksRow('claude', hooks({}))).toMatchObject({ id: 'hooks:claude', label: 'Claude Code hooks' });
    expect(hooksRow('claude', hooks({})).fix).toEqual({ kind: 'hooks', agent: 'claude', label: 'Install' });
    expect(hooksRow('claude', hooks({ claudeDetected: false })).fix).toBeUndefined();
    expect(hooksRow('claude', hooks({ alreadyInstalled: true })).level).toBe('ok');
    expect(hooksRow('claude', null).level).toBe('info');
  });

  it('names the agent and marks Codex as a preview', () => {
    const row = hooksRow('codex', hooks({ agent: 'codex', detected: true, claudeDetected: false }));
    expect(row).toMatchObject({ id: 'hooks:codex', label: 'Codex hooks (preview)', level: 'missing' });
    expect(row.fix).toEqual({ kind: 'hooks', agent: 'codex', label: 'Install' });
    expect(row.text).toContain('Codex');
  });

  it('has no install when the agent has not run', () => {
    const row = hooksRow('copilot', hooks({ agent: 'copilot', detected: false, claudeDetected: false }));
    expect(row.fix).toBeUndefined();
    expect(row.text).toBe('Copilot has not run on this machine');
  });

  it('offers an update when only the hook script is out of date', () => {
    const row = hooksRow('claude', hooks({ scriptState: 'outdated' }));
    expect(row).toMatchObject({ level: 'missing', text: expect.stringContaining('Hook script out of date') });
    expect(row.fix).toEqual({ kind: 'hooks', agent: 'claude', label: 'Update' });
  });

  it('reports a newer script from another build as installed', () => {
    expect(hooksRow('claude', hooks({ alreadyInstalled: true, scriptState: 'newer' }))).toMatchObject({
      level: 'ok',
      text: 'Installed',
    });
  });

  it('reports Codex hooks installed but not yet trusted', () => {
    const base = { agent: 'codex' as const, detected: true, alreadyInstalled: true };
    const row = hooksRow('codex', hooks({ ...base, trust: 'untrusted' }));
    expect(row).toMatchObject({ level: 'info' });
    expect(row.text).toContain('not yet trusted');
    expect(row.fix).toBeUndefined();
    expect(hooksRow('codex', hooks({ ...base, trust: 'trusted' }))).toMatchObject({ level: 'ok', text: 'Installed' });
    expect(hooksRow('codex', hooks({ ...base, trust: 'unknown' })).level).toBe('info');
  });
});
