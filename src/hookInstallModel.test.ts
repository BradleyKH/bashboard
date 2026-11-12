import { describe, expect, it } from 'vitest';
import { hookAction, hookActionVerb, scriptLineLabel } from './hookInstallModel';

describe('hookAction', () => {
  const stop = { Stop: [{}] };

  it('is an update when nothing is added and the hook program is outdated', () => {
    expect(hookAction({ additions: {}, updates: {}, scriptState: 'outdated' })).toBe('update');
    expect(hookAction({ additions: stop, updates: {}, scriptState: 'outdated' })).toBe('install');
    expect(hookAction({ additions: {}, updates: {}, scriptState: 'missing' })).toBe('install');
    expect(hookAction({ additions: stop, updates: {}, scriptState: 'newer' })).toBe('install');
  });

  it('is an update when nothing is added and existing entries are out of date', () => {
    expect(hookAction({ additions: {}, updates: stop, scriptState: 'current' })).toBe('update');
    expect(hookAction({ additions: {}, updates: stop, scriptState: 'outdated' })).toBe('update');
    expect(hookAction({ additions: {}, updates: stop, scriptState: 'missing' })).toBe('update');
    expect(hookAction({ additions: { Notification: [{}] }, updates: stop, scriptState: 'current' })).toBe('install');
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
