import { describe, expect, it } from 'vitest';
import { formatSize } from './formatSize';

describe('formatSize', () => {
  it('prints bytes below 1 KB', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
  });

  it('keeps one decimal under 10 and none from 10 up', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(3482)).toBe('3.4 KB');
    expect(formatSize(10 * 1024)).toBe('10 KB');
    expect(formatSize(1.2 * 1024 * 1024)).toBe('1.2 MB');
  });

  it('tops out at GB', () => {
    expect(formatSize(2048 * 1024 ** 3)).toBe('2048 GB');
  });
});
