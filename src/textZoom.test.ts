import { describe, expect, it } from 'vitest';
import { stepZoom, ZOOM_LEVELS, zoomPercent } from './textZoom';

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
