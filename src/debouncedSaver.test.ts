import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebouncedSaver } from './debouncedSaver';

describe('DebouncedSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    let state = { n: 1 };
    const save = vi.fn((_: { n: number }) => Promise.resolve());
    const saver = new DebouncedSaver(() => state, save, 1000);
    return { saver, save, set: (n: number) => (state = { n }) };
  }

  it('saves once after changes settle', async () => {
    const { saver, save } = setup();
    saver.schedule();
    await vi.advanceTimersByTimeAsync(500);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ n: 1 });
  });

  it('skips a save whose JSON matches the last one', async () => {
    const { saver, save, set } = setup();
    await saver.flush();
    saver.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    set(2);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('flush saves immediately and cancels the pending save', async () => {
    const { saver, save } = setup();
    saver.schedule();
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed save', async () => {
    const { saver, save } = setup();
    save.mockImplementationOnce(() => Promise.reject(new Error('disk')));
    await expect(saver.flush()).rejects.toThrow('disk');
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('cancel drops the pending save', async () => {
    const { saver, save } = setup();
    saver.schedule();
    await saver.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
  });

  it('cancel waits for a save already running', async () => {
    const { saver, save } = setup();
    let finish!: () => void;
    save.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    const flushing = saver.flush();
    let cancelled = false;
    const cancelling = saver.cancel().then(() => (cancelled = true));
    await Promise.resolve();
    expect(cancelled).toBe(false);
    finish();
    await Promise.all([flushing, cancelling]);
    expect(cancelled).toBe(true);
  });
});
