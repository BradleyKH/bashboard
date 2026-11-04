import { describe, expect, it } from 'vitest';
import { RESTORED_SEPARATOR, replayText } from './scrollbackModel';

describe('replayText', () => {
  it('writes nothing for blank or missing scrollback', () => {
    expect(replayText('')).toBe('');
    expect(replayText('  \r\n ')).toBe('');
  });

  it('follows the saved text with the separator', () => {
    expect(replayText('$ ls\r\na b\r\n$ ')).toBe(`$ ls\r\na b\r\n$ ${RESTORED_SEPARATOR}`);
  });

  it('resets attributes before the separator so a dangling color cannot tint it', () => {
    expect(RESTORED_SEPARATOR.startsWith('\x1b[0m')).toBe(true);
  });
});
