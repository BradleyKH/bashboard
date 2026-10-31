import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollTimer, shouldPoll, type PollGate } from './pollTimer';

const ON: PollGate = { enabled: true, expanded: true, onScreen: true, windowShown: true };

describe('shouldPoll', () => {
  it('is true only when all four fields are true', () => {
    expect(shouldPoll(ON)).toBe(true);
    for (const key of Object.keys(ON) as (keyof PollGate)[]) {
      expect(shouldPoll({ ...ON, [key]: false })).toBe(false);
    }
  });
});

describe('PollTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks at once, then at each interval', () => {
    const tick = vi.fn();
    const t = new PollTimer(2000, tick);
    t.setGate(ON);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('does not tick while a field is still off', () => {
    const tick = vi.fn();
    const t = new PollTimer(2000, tick);
    t.setGate({ enabled: true, expanded: true, onScreen: true, windowShown: false });
    vi.advanceTimersByTime(10000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('starts with the window shown', () => {
    const tick = vi.fn();
    const t = new PollTimer(2000, tick);
    t.setGate({ enabled: true, expanded: true, onScreen: true });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  for (const key of ['enabled', 'expanded', 'onScreen', 'windowShown'] as const) {
    it(`stops when ${key} turns off and ticks at once on restart`, () => {
      const tick = vi.fn();
      const t = new PollTimer(2000, tick);
      t.setGate(ON);
      tick.mockClear();
      t.setGate({ [key]: false });
      vi.advanceTimersByTime(10000);
      expect(tick).not.toHaveBeenCalled();
      t.setGate({ [key]: true });
      expect(tick).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      expect(tick).toHaveBeenCalledTimes(2);
    });
  }

  it('a setGate that leaves shouldPoll unchanged does nothing', () => {
    const tick = vi.fn();
    const t = new PollTimer(2000, tick);
    t.setGate(ON);
    t.setGate({ enabled: true });
    t.setGate(ON);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
