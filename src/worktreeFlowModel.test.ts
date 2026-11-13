import { describe, expect, it } from 'vitest';
import type { WorktreePlan } from './worktreeApi';
import { newDialogStatus, paneProfile, willRunSetup, type NewDialogState } from './worktreeFlowModel';

const plan: WorktreePlan = {
  mainRoot: 'C:\\r\\app',
  branch: 'feat',
  baseRef: 'origin/main',
  baseSha: 'abcdef1234',
  shortSha: 'abcdef1',
  path: 'C:\\r\\app-feat',
  name: 'app-feat',
  hint: false,
};

const base: NewDialogState = {
  folder: 'C:\\r\\app',
  isGit: true,
  branch: 'feat',
  plan,
  planError: null,
  planning: false,
  creating: false,
  createError: null,
};

describe('newDialogStatus', () => {
  it('says why there is nothing to branch from', () => {
    expect(newDialogStatus({ ...base, folder: null })).toMatchObject({ error: true, canCreate: false });
    expect(newDialogStatus({ ...base, isGit: false })).toEqual({
      text: 'C:\\r\\app is not in a git repo.',
      error: true,
      canCreate: false,
    });
  });

  it('enables Create only for a resolved plan of the current text', () => {
    expect(newDialogStatus(base)).toEqual({ text: 'Branching feat from origin/main (abcdef1)', error: false, canCreate: true });
    expect(newDialogStatus({ ...base, planning: true }).canCreate).toBe(false);
    expect(newDialogStatus({ ...base, plan: null })).toMatchObject({ canCreate: false });
    expect(newDialogStatus({ ...base, branch: '  ' })).toMatchObject({ error: false, canCreate: false });
  });

  it('shows plan errors inline', () => {
    expect(newDialogStatus({ ...base, plan: null, planError: 'Branch feat already exists' })).toEqual({
      text: 'Branch feat already exists',
      error: true,
      canCreate: false,
    });
  });

  it('is busy while creating and lets a failed create be retried', () => {
    expect(newDialogStatus({ ...base, creating: true })).toMatchObject({ error: false, canCreate: false });
    expect(newDialogStatus({ ...base, createError: 'fetch failed' })).toEqual({
      text: 'fetch failed',
      error: true,
      canCreate: true,
    });
  });
});

describe('willRunSetup', () => {
  it('runs a trusted script, an approved one, and nothing else', () => {
    expect(willRunSetup('none', null)).toBe(false);
    expect(willRunSetup('trusted', null)).toBe(true);
    expect(willRunSetup('needsApproval', true)).toBe(true);
    expect(willRunSetup('needsApproval', false)).toBe(false);
    expect(willRunSetup('needsApproval', null)).toBe(false);
  });
});

describe('paneProfile', () => {
  it('uses Git Bash whenever a command is typed on Windows', () => {
    expect(paneProfile('bash .bashboard/setup.sh', 'windows')).toBe('gitBash');
    expect(paneProfile("claude 'fix it'", 'windows')).toBe('gitBash');
    expect(paneProfile(null, 'windows')).toBeUndefined();
    expect(paneProfile('bash .bashboard/setup.sh', 'macos')).toBeUndefined();
  });
});
