import { describe, expect, it } from 'vitest';
import { GIT_BASH_PROFILE, parseProfileId, profileName } from './profiles';

describe('profileName', () => {
  it('prefers the listed name, then the static name, then the id', () => {
    expect(profileName('gitBash', [{ ...GIT_BASH_PROFILE, name: 'Bash' }])).toBe('Bash');
    expect(profileName('pwsh', [GIT_BASH_PROFILE])).toBe('PowerShell 7');
    expect(profileName('powershell')).toBe('Windows PowerShell');
    expect(profileName('cmd')).toBe('Command Prompt');
    expect(profileName('zsh')).toBe('zsh');
    expect(profileName('toString')).toBe('toString');
  });
});

describe('parseProfileId', () => {
  it('accepts fixed ids and shell file names', () => {
    for (const id of ['pwsh', 'gitBash', 'nu', 'fish-4', 'x1']) expect(parseProfileId(id)).toBe(id);
  });

  it('rejects everything else', () => {
    for (const bad of ['', 'a b', '1x', '-a', '../x', 'PWSH', 'a'.repeat(33), 5, null, undefined]) {
      expect(parseProfileId(bad)).toBeUndefined();
    }
  });
});
