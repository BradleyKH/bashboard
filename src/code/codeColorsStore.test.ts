import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codeColorsDefault,
  loadCodeColorsDefault,
  onCodeColorsDefaultChange,
  parseCodeColorsMode,
  setCodeColorsDefault,
} from './codeColorsStore';

afterEach(() => {
  loadCodeColorsDefault('syntax');
  onCodeColorsDefaultChange(() => {});
});

describe('parseCodeColorsMode', () => {
  it('keeps plain and falls back to syntax for everything else', () => {
    expect(parseCodeColorsMode('plain')).toBe('plain');
    expect(parseCodeColorsMode('syntax')).toBe('syntax');
    for (const raw of [undefined, null, '', 'Plain', 1, true, {}]) {
      expect(parseCodeColorsMode(raw)).toBe('syntax');
    }
  });
});

describe('code colors default', () => {
  it('starts in syntax', () => {
    expect(codeColorsDefault()).toBe('syntax');
  });

  it('loads without notifying', () => {
    const fn = vi.fn();
    onCodeColorsDefaultChange(fn);
    loadCodeColorsDefault('plain');
    expect(codeColorsDefault()).toBe('plain');
    expect(fn).not.toHaveBeenCalled();
  });

  it('notifies the listener when set', () => {
    const fn = vi.fn();
    onCodeColorsDefaultChange(fn);
    setCodeColorsDefault('plain');
    expect(codeColorsDefault()).toBe('plain');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
