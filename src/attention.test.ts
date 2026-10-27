import { describe, expect, it } from 'vitest';
import { AttentionTracker } from './attention';

describe('AttentionTracker', () => {
  it('raises on the first observation being waiting', () => {
    const t = new AttentionTracker();
    expect(t.observe('a', 'waiting', false)).toBe(true);
    expect(t.has('a')).toBe(true);
  });

  it('raises nothing for done', () => {
    for (const before of ['idle', 'working', 'waiting'] as const) {
      const t = new AttentionTracker();
      t.observe('a', before, true);
      expect(t.observe('a', 'done', false)).toBe(false);
      expect(t.has('a')).toBe(false);
    }
  });

  it('raises once on idle to waiting', () => {
    const t = new AttentionTracker();
    expect(t.observe('a', 'idle', false)).toBe(false);
    expect(t.observe('a', 'waiting', false)).toBe(true);
  });

  it('does not re-raise on waiting to waiting', () => {
    const t = new AttentionTracker();
    t.observe('a', 'waiting', false);
    t.clear('a');
    expect(t.observe('a', 'waiting', false)).toBe(false);
    expect(t.has('a')).toBe(false);
  });

  it('raises again after leaving waiting', () => {
    const t = new AttentionTracker();
    t.observe('a', 'waiting', false);
    t.observe('a', 'idle', false);
    t.clear('a');
    expect(t.observe('a', 'waiting', false)).toBe(true);
  });

  it('suppresses when seen but still records the status', () => {
    const t = new AttentionTracker();
    expect(t.observe('a', 'waiting', true)).toBe(false);
    expect(t.has('a')).toBe(false);
    expect(t.observe('a', 'waiting', false)).toBe(false);
  });

  it('raises for the bell unless seen, and only once', () => {
    const t = new AttentionTracker();
    expect(t.raise('a', true)).toBe(false);
    expect(t.raise('a', false)).toBe(true);
    expect(t.raise('a', false)).toBe(false);
  });

  it('clear returns true only when something was set', () => {
    const t = new AttentionTracker();
    expect(t.clear('a')).toBe(false);
    t.raise('a', false);
    expect(t.clear('a')).toBe(true);
    expect(t.clear('a')).toBe(false);
  });

  it('forget resets the stored status and attention', () => {
    const t = new AttentionTracker();
    t.observe('a', 'waiting', false);
    t.forget('a');
    expect(t.has('a')).toBe(false);
    expect(t.observe('a', 'waiting', false)).toBe(true);
  });
});
