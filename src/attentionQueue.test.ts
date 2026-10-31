import { describe, expect, it } from 'vitest';
import { attentionQueue, nextAttention, type AttentionEntry } from './attentionQueue';

const e = (
  paneId: string,
  status: AttentionEntry['status'],
  changedAt: number,
  tabId = 't1',
): AttentionEntry => ({ paneId, tabId, status, changedAt });

describe('attentionQueue', () => {
  it('puts waiting first, oldest first, then done and failed interleaved by time', () => {
    const entries = [
      e('d1', 'done', 5),
      e('w2', 'waiting', 20),
      e('f1', 'failed', 3),
      e('i', 'idle', 1),
      e('w1', 'waiting', 10),
      e('k', 'working', 2),
      e('d2', 'done', 4),
    ];
    expect(attentionQueue(entries, ['t1'])).toEqual(['w1', 'w2', 'f1', 'd2', 'd1']);
  });

  it('breaks ties by tab order, then input order', () => {
    const entries = [
      e('b', 'waiting', 1, 't2'),
      e('a', 'waiting', 1, 't1'),
      e('c', 'waiting', 1, 't1'),
    ];
    expect(attentionQueue(entries, ['t1', 't2'])).toEqual(['a', 'c', 'b']);
    expect(attentionQueue(entries, ['t2', 't1'])).toEqual(['b', 'a', 'c']);
  });

  it('is empty when nothing needs attention', () => {
    expect(attentionQueue([e('a', 'idle', 1), e('b', 'working', 2)], ['t1'])).toEqual([]);
  });
});

describe('nextAttention', () => {
  const entries = [e('a', 'waiting', 1), e('b', 'waiting', 2), e('c', 'done', 3)];

  it('moves past the focused pane and wraps at the end', () => {
    expect(nextAttention(entries, ['t1'], 'a')).toBe('b');
    expect(nextAttention(entries, ['t1'], 'b')).toBe('c');
    expect(nextAttention(entries, ['t1'], 'c')).toBe('a');
  });

  it('returns the only entry for a queue of one', () => {
    expect(nextAttention([e('a', 'waiting', 1)], ['t1'], 'a')).toBe('a');
  });

  it('returns the first entry when the focused pane is not queued', () => {
    expect(nextAttention(entries, ['t1'], 'zzz')).toBe('a');
  });

  it('returns null for an empty queue', () => {
    expect(nextAttention([], ['t1'], 'a')).toBeNull();
  });
});
