import { describe, expect, it } from 'vitest';
import { pathDragLabel } from './pathDragLayer';

describe('pathDragLabel', () => {
  it('uses the last segment of one path', () => {
    expect(pathDragLabel(['C:\\repo\\src\\main.ts'])).toBe('main.ts');
    expect(pathDragLabel(['/a/b/c.txt'])).toBe('c.txt');
  });

  it('ignores a trailing separator', () => {
    expect(pathDragLabel(['C:/repo/src/'])).toBe('src');
    expect(pathDragLabel(['C:\\repo\\src\\'])).toBe('src');
  });

  it('adds a count for the remaining paths', () => {
    expect(pathDragLabel(['/a/one.ts', '/a/two.ts', '/a/three.ts'])).toBe('one.ts +2');
  });
});
