import { describe, expect, it } from 'vitest';
import {
  SCRATCH_SAVE_DELAY_MS,
  isScratchEmpty,
  newScratchId,
  scratchTitle,
} from './scratchModel';

describe('scratchTitle', () => {
  it('uses the first non-empty line, trimmed', () => {
    expect(scratchTitle('\n\n   Groceries  \nmilk')).toBe('Groceries');
  });

  it('handles CRLF line endings', () => {
    expect(scratchTitle('first\r\nsecond')).toBe('first');
  });

  it('falls back to "Scratch" for blank text', () => {
    expect(scratchTitle('')).toBe('Scratch');
    expect(scratchTitle('  \n\t\n')).toBe('Scratch');
  });

  it('keeps a title of exactly 32 characters whole', () => {
    const line = 'a'.repeat(32);
    expect(scratchTitle(line)).toBe(line);
  });

  it('shortens a longer line to 32 characters including the ellipsis', () => {
    const title = scratchTitle('b'.repeat(40));
    expect(title).toBe(`${'b'.repeat(29)}...`);
    expect(title).toHaveLength(32);
  });
});

describe('isScratchEmpty', () => {
  it('is true for empty and whitespace-only text', () => {
    expect(isScratchEmpty('')).toBe(true);
    expect(isScratchEmpty(' \n\t ')).toBe(true);
  });

  it('is false once any non-whitespace character is present', () => {
    expect(isScratchEmpty(' x ')).toBe(false);
  });
});

describe('newScratchId', () => {
  it('returns a distinct UUID string each call', () => {
    const a = newScratchId();
    const b = newScratchId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('SCRATCH_SAVE_DELAY_MS', () => {
  it('is half a second', () => {
    expect(SCRATCH_SAVE_DELAY_MS).toBe(500);
  });
});
