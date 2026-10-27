import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchRunner } from './searchRunner';
import type { SearchBatch } from './searchApi';
import { DEFAULT_SEARCH_OPTIONS } from './searchOptions';
import type { SearchResults } from './searchModel';

interface Call {
  query: string;
  emit: (b: SearchBatch) => void;
  resolve: (id: number) => void;
  reject: (e: unknown) => void;
}

function setup() {
  const calls: Call[] = [];
  const cancelled: number[] = [];
  const states: SearchResults[] = [];
  const start = vi.fn((_root: string, query: string, _o: unknown, onBatch: (b: SearchBatch) => void) => {
    return new Promise<number>((resolve, reject) => calls.push({ query, emit: onBatch, resolve, reject }));
  });
  const cancel = vi.fn((id: number) => {
    cancelled.push(id);
    return Promise.resolve();
  });
  const runner = new SearchRunner({ onChange: (s) => states.push(s), start, cancel });
  return { runner, calls, cancelled, states, start, cancel };
}

const last = <T>(xs: T[]): T => xs[xs.length - 1];
const flush = () => Promise.resolve().then(() => Promise.resolve());
const file = (path: string): SearchBatch => ({ type: 'file', path, matches: [{ line: 1, text: 'x', ranges: [] }] });

describe('SearchRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces schedule by 250 ms and only runs the last query', () => {
    const { runner, start } = setup();
    runner.schedule('/r', 'a', DEFAULT_SEARCH_OPTIONS);
    vi.advanceTimersByTime(200);
    runner.schedule('/r', 'ab', DEFAULT_SEARCH_OPTIONS);
    vi.advanceTimersByTime(249);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toBe('ab');
  });

  it('runNow skips the delay and cancels a pending debounce', () => {
    const { runner, start } = setup();
    runner.schedule('/r', 'a', DEFAULT_SEARCH_OPTIONS);
    runner.runNow('/r', 'b', DEFAULT_SEARCH_OPTIONS);
    expect(start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('cancels the previous search before starting the next', async () => {
    const { runner, calls, cancelled } = setup();
    runner.runNow('/r', 'a', DEFAULT_SEARCH_OPTIONS);
    calls[0].resolve(11);
    await flush();
    runner.runNow('/r', 'b', DEFAULT_SEARCH_OPTIONS);
    expect(cancelled).toEqual([11]);
  });

  it('cancels a search whose id arrives after it was superseded', async () => {
    const { runner, calls, cancelled } = setup();
    runner.runNow('/r', 'a', DEFAULT_SEARCH_OPTIONS);
    runner.runNow('/r', 'b', DEFAULT_SEARCH_OPTIONS);
    calls[0].resolve(5);
    await flush();
    expect(cancelled).toEqual([5]);
  });

  it('drops batches from a superseded run', async () => {
    const { runner, calls, states } = setup();
    runner.runNow('/r', 'a', DEFAULT_SEARCH_OPTIONS);
    calls[0].resolve(1);
    await flush();
    runner.runNow('/r', 'b', DEFAULT_SEARCH_OPTIONS);
    calls[0].emit(file('stale.ts'));
    calls[1].emit(file('fresh.ts'));
    expect(last(states).groups.map((g) => g.path)).toEqual(['fresh.ts']);
  });

  it('reports empty results without starting for an empty query', async () => {
    const { runner, calls, cancelled, states, start } = setup();
    runner.runNow('/r', 'a', DEFAULT_SEARCH_OPTIONS);
    calls[0].resolve(3);
    await flush();
    runner.schedule('/r', '', DEFAULT_SEARCH_OPTIONS);
    expect(start).toHaveBeenCalledTimes(1);
    expect(cancelled).toEqual([3]);
    expect(last(states)).toMatchObject({ groups: [], done: false, error: null });
  });

  it('reports a rejected start as an error', async () => {
    const { runner, calls, states } = setup();
    runner.runNow('/r', '(', DEFAULT_SEARCH_OPTIONS);
    calls[0].reject('invalid regex');
    await flush();
    expect(last(states)).toMatchObject({ error: 'invalid regex', done: true });
  });

  it('ignores a rejection from a superseded run', async () => {
    const { runner, calls, states } = setup();
    runner.runNow('/r', '(', DEFAULT_SEARCH_OPTIONS);
    runner.runNow('/r', 'ok', DEFAULT_SEARCH_OPTIONS);
    calls[0].reject('bad');
    await flush();
    expect(last(states).error).toBeNull();
  });

  it('dispose cancels the running search, clears the timer, and goes quiet', async () => {
    const { runner, calls, cancelled, states, start } = setup();
    runner.runNow('/r', 'a', DEFAULT_SEARCH_OPTIONS);
    calls[0].resolve(9);
    await flush();
    runner.schedule('/r', 'b', DEFAULT_SEARCH_OPTIONS);
    runner.dispose();
    expect(cancelled).toEqual([9]);
    const n = states.length;
    calls[0].emit(file('late.ts'));
    vi.advanceTimersByTime(1000);
    runner.runNow('/r', 'c', DEFAULT_SEARCH_OPTIONS);
    expect(states).toHaveLength(n);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
