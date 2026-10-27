import { describe, expect, it } from 'vitest';
import { forget, recentTerminal, touch } from './focusHistory';

describe('touch', () => {
  it('moves an existing id to the front without mutating the input', () => {
    const before = ['a', 'b', 'c'];
    expect(touch(before, 'c')).toEqual(['c', 'a', 'b']);
    expect(before).toEqual(['a', 'b', 'c']);
  });

  it('adds an unseen id to the front', () => {
    expect(touch(['a'], 'z')).toEqual(['z', 'a']);
  });

  it('keeps a single entry when touching the front again', () => {
    expect(touch(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });
});

describe('forget', () => {
  it('drops the id and returns a new array', () => {
    const before = ['a', 'b'];
    expect(forget(before, 'a')).toEqual(['b']);
    expect(before).toEqual(['a', 'b']);
  });

  it('is a no-op for an unknown id', () => {
    expect(forget(['a'], 'x')).toEqual(['a']);
  });
});

describe('recentTerminal', () => {
  const isTerminal = (id: string) => id.startsWith('t');

  it('returns the most recent terminal that belongs to the tab', () => {
    const history = ['s1', 't2', 't1'];
    expect(recentTerminal(history, ['t1', 't2', 's1'], isTerminal)).toBe('t2');
  });

  it('skips history entries from other tabs', () => {
    const history = ['t9', 't1'];
    expect(recentTerminal(history, ['t1', 't2'], isTerminal)).toBe('t1');
  });

  it('skips non-terminal history entries', () => {
    const history = ['s1', 't1'];
    expect(recentTerminal(history, ['s1', 't1'], isTerminal)).toBe('t1');
  });

  it('falls back to the first terminal in pane order', () => {
    expect(recentTerminal([], ['s1', 't3', 't2'], isTerminal)).toBe('t3');
  });

  it('returns null when the tab has no terminal', () => {
    expect(recentTerminal(['s1'], ['s1'], isTerminal)).toBeNull();
    expect(recentTerminal([], [], isTerminal)).toBeNull();
  });
});
