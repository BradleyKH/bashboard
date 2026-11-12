import { describe, expect, it } from 'vitest';
import { hookAction, hookActionVerb, scriptLineLabel } from './hookInstallModel';

describe('hookAction', () => {
  const stop = { Stop: [{}] };

  it('is an update only when nothing is added and the hook program is outdated', () => {
    expect(hookAction({ additions: {}, scriptState: 'outdated' })).toBe('update');
    expect(hookAction({ additions: stop, scriptState: 'outdated' })).toBe('install');
    expect(hookAction({ additions: {}, scriptState: 'missing' })).toBe('install');
    expect(hookAction({ additions: stop, scriptState: 'newer' })).toBe('install');
  });

  it('names the verb', () => {
    expect(hookActionVerb('update')).toBe('Update');
    expect(hookActionVerb('install')).toBe('Install');
  });
});

describe('scriptLineLabel', () => {
  it('describes the write, or nothing when the hook program is left alone', () => {
    expect(scriptLineLabel('missing')).toBe('Writes the hook program to');
    expect(scriptLineLabel('outdated')).toBe('Updates the hook program at');
    expect(scriptLineLabel('current')).toBeNull();
    expect(scriptLineLabel('newer')).toBeNull();
  });
});
