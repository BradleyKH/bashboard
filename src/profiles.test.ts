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
  it('accepts short letter-only ids', () => {
    expect(parseProfileId('pwsh')).toBe('pwsh');
    expect(parseProfileId('gitBash')).toBe('gitBash');
  });

  it('rejects everything else', () => {
    for (const bad of ['', 'a b', 'a-b', 'x1', 'a'.repeat(33), 5, null, undefined]) {
      expect(parseProfileId(bad)).toBeUndefined();
    }
  });
});
