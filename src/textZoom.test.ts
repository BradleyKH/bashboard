import { describe, expect, it } from 'vitest';
import { accumulateWheel, stepZoom, ZOOM_LEVELS, zoomPercent } from './textZoom';

describe('stepZoom', () => {
  it('moves one level at a time', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
  });

  it('stays at either end', () => {
    expect(stepZoom(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 1)).toBe(3);
    expect(stepZoom(ZOOM_LEVELS[0], -1)).toBe(0.5);
  });

  it('snaps an off-level value to the neighboring level', () => {
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(1.05, -1)).toBe(1);
  });
});

describe('zoomPercent', () => {
  it('rounds to a whole percent', () => {
    expect(zoomPercent(0.67)).toBe('67%');
    expect(zoomPercent(1.25)).toBe('125%');
  });
});

describe('accumulateWheel', () => {
  it('steps once per mouse notch, wheel up zooming in', () => {
    expect(accumulateWheel(0, -100)).toEqual({ dir: 1, acc: 0 });
    expect(accumulateWheel(0, 100)).toEqual({ dir: -1, acc: 0 });
  });

  it('adds small pinch deltas until they cross a step', () => {
    let acc = 0;
    const dirs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = accumulateWheel(acc, -10);
      acc = r.acc;
      dirs.push(r.dir);
    }
    expect(dirs.filter((d) => d === 1)).toHaveLength(2);
    expect(dirs.filter((d) => d === -1)).toHaveLength(0);
  });

  it('starts over when the direction reverses', () => {
    expect(accumulateWheel(-40, 20)).toEqual({ dir: 0, acc: 20 });
  });
});
