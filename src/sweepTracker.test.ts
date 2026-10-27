import { describe, expect, it } from 'vitest';
import { applyActivity } from './sweepTracker';

describe('applyActivity', () => {
  it('records new ptys as changed', () => {
    const { next, changed } = applyActivity(new Map(), [{ id: 1, busy: false }], 100);
    expect(changed).toBe(true);
    expect(next.get(1)).toEqual({ busy: false, changedAt: 100 });
  });

  it('keeps changedAt while busy holds and moves it when busy flips', () => {
    const prev = new Map([[1, { busy: false, changedAt: 100 }]]);
    const same = applyActivity(prev, [{ id: 1, busy: false }], 200);
    expect(same.changed).toBe(false);
    expect(same.next.get(1)).toEqual({ busy: false, changedAt: 100 });
    const flipped = applyActivity(prev, [{ id: 1, busy: true }], 300);
    expect(flipped.changed).toBe(true);
    expect(flipped.next.get(1)).toEqual({ busy: true, changedAt: 300 });
  });

  it('drops ptys missing from the sweep', () => {
    const prev = new Map([[1, { busy: true, changedAt: 100 }]]);
    const { next, changed } = applyActivity(prev, [], 200);
    expect(changed).toBe(true);
    expect(next.size).toBe(0);
  });
});
