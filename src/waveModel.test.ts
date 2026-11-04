import { describe, expect, it } from 'vitest';
import { cpuLevel, ease, netLevel, phaseSpeed, wavePoints } from './waveModel';

describe('cpuLevel', () => {
  it('maps percent to 0..1 and clamps', () => {
    expect(cpuLevel(50)).toBe(0.5);
    expect(cpuLevel(140)).toBe(1);
    expect(cpuLevel(-3)).toBe(0);
  });

  it('treats a missing reading as idle', () => {
    expect(cpuLevel(null)).toBe(0);
    expect(cpuLevel(Number.NaN)).toBe(0);
  });
});

describe('netLevel', () => {
  it('is zero with no traffic or no reading', () => {
    expect(netLevel(0, 0)).toBe(0);
    expect(netLevel(null, null)).toBe(0);
  });

  it('rises on a log scale and tops out at 1', () => {
    const trickle = netLevel(2_000, 0);
    const busy = netLevel(2_000_000, 0);
    expect(trickle).toBeGreaterThan(0.3);
    expect(busy).toBeGreaterThan(trickle);
    expect(netLevel(1e9, 1e9)).toBe(1);
  });
});

describe('ease', () => {
  it('approaches the target without overshooting', () => {
    const v = ease(0, 1, 1.5);
    expect(v).toBeGreaterThan(0.6);
    expect(v).toBeLessThan(0.7);
    expect(ease(0, 1, 100)).toBeCloseTo(1);
  });

  it('holds still for a zero or negative step', () => {
    expect(ease(0.2, 1, 0)).toBe(0.2);
    expect(ease(0.2, 1, -1)).toBe(0.2);
  });
});

describe('wavePoints', () => {
  it('returns n points inside the unit square', () => {
    const pts = wavePoints(0.4, 1.2, 50);
    expect(pts).toHaveLength(50);
    for (const [x, y] of pts) {
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
    }
  });

  it('changes shape with load', () => {
    expect(wavePoints(0, 0, 20)).not.toEqual(wavePoints(1, 0, 20));
  });
});

describe('phaseSpeed', () => {
  it('drifts at rest and speeds up with traffic', () => {
    expect(phaseSpeed(0)).toBeGreaterThan(0);
    expect(phaseSpeed(1)).toBeGreaterThan(phaseSpeed(0));
  });
});
