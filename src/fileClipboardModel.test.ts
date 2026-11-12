import { describe, expect, it } from 'vitest';
import { pasteMoves } from './fileClipboardModel';

describe('pasteMoves', () => {
  it('moves when the clipboard says cut', () => {
    expect(pasteMoves({ paths: ['C:/r/a.txt'], cut: true }, [])).toBe(true);
  });

  it('moves when the app cut the same paths, in any order and case', () => {
    expect(pasteMoves({ paths: ['C:/r/b.txt', 'C:/R/A.txt'], cut: false }, ['c:/r/a.txt', 'C:/r/b.txt'])).toBe(true);
  });

  it('copies when the app cut something else, or nothing', () => {
    expect(pasteMoves({ paths: ['C:/r/a.txt'], cut: false }, ['C:/r/a.txt', 'C:/r/b.txt'])).toBe(false);
    expect(pasteMoves({ paths: ['C:/r/a.txt'], cut: false }, ['C:/r/z.txt'])).toBe(false);
    expect(pasteMoves({ paths: ['C:/r/a.txt'], cut: false }, [])).toBe(false);
  });
});
