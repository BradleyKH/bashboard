import { describe, expect, it } from 'vitest';
import { parseLineTarget } from './goToLineModel';

describe('parseLineTarget', () => {
  it('reads a bare line', () => {
    expect(parseLineTarget('42')).toEqual({ line: 42, column: null });
    expect(parseLineTarget('  7 ')).toEqual({ line: 7, column: null });
  });

  it('reads line:column and line,column', () => {
    expect(parseLineTarget('42:7')).toEqual({ line: 42, column: 7 });
    expect(parseLineTarget('42 , 7')).toEqual({ line: 42, column: 7 });
  });

  it('rejects empty, zero, and other text', () => {
    for (const text of ['', ' ', '0', '3:0', 'abc', '4:', ':4', '-2', '1.5', '4:5:6']) {
      expect(parseLineTarget(text), text).toBeNull();
    }
  });
});
