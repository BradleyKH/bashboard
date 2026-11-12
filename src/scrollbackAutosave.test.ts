import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScrollbackAutosave } from './scrollbackAutosave';

describe('startScrollbackAutosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves on each interval only while enabled', async () => {
    let enabled = true;
    const save = vi.fn(() => Promise.resolve());
    const stop = startScrollbackAutosave(() => enabled, save, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    enabled = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    stop();
  });

  it('skips a tick while the previous pass is still running', async () => {
    let finish: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const stop = startScrollbackAutosave(() => true, save, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps running after a failed pass', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const save = vi.fn(() => Promise.reject(new Error('disk full')));
    const stop = startScrollbackAutosave(() => true, save, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    stop();
    warn.mockRestore();
  });
});
