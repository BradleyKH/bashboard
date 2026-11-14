import { describe, expect, it } from 'vitest';
import { nextAgent, nextInWalk } from './attentionQueue';

describe('nextInWalk', () => {
  const keys = ['a', 'b', 'c'];

  it('starts at the first row with no position', () => {
    expect(nextInWalk(keys, null)).toBe(0);
  });

  it('moves past the current row and wraps at the end', () => {
    expect(nextInWalk(keys, { key: 'a', index: 0 })).toBe(1);
    expect(nextInWalk(keys, { key: 'b', index: 1 })).toBe(2);
    expect(nextInWalk(keys, { key: 'c', index: 2 })).toBe(0);
  });

  it('follows the key when the list reorders around it', () => {
    expect(nextInWalk(['c', 'a', 'b'], { key: 'a', index: 0 })).toBe(2);
  });

  it('resumes at the old index when the walked row left the list', () => {
    // 'b' was at 1 and cleared on arrival; 'c' slid into its place and is next.
    expect(nextInWalk(['a', 'c'], { key: 'b', index: 1 })).toBe(1);
  });

  it('wraps to the first row when the vanished row was last', () => {
    expect(nextInWalk(['a', 'b'], { key: 'c', index: 2 })).toBe(0);
  });

  it('starts at the first row for a focused pane not in the list', () => {
    expect(nextInWalk(keys, { key: 'zzz', index: 0 })).toBe(0);
  });

  it('returns the only row for a list of one', () => {
    expect(nextInWalk(['a'], { key: 'a', index: 0 })).toBe(0);
  });

  it('returns null for an empty list', () => {
    expect(nextInWalk([], null)).toBeNull();
    expect(nextInWalk([], { key: 'a', index: 0 })).toBeNull();
  });
});

describe('nextAgent', () => {
  it('cycles the agent terminals in order and wraps', () => {
    expect(nextAgent(['x', 'y'], 'x')).toBe('y');
    expect(nextAgent(['x', 'y'], 'y')).toBe('x');
  });

  it('starts at the first agent when the focused pane is not one', () => {
    expect(nextAgent(['x', 'y'], 's')).toBe('x');
  });

  it('returns null with no agent terminals', () => {
    expect(nextAgent([], 's')).toBeNull();
  });
});
