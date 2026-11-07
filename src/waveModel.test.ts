import { describe, expect, it } from 'vitest';
import { WAVE_RATIOS, cpuLevel, ease, netLevel, phaseSpeed, waveLayers, wavePoints } from './waveModel';

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

describe('waveLayers', () => {
  it('draws the calm figure alone at idle', () => {
    expect(waveLayers(0)).toEqual([{ ratio: WAVE_RATIOS[0], weight: 1 }]);
    expect(waveLayers(-1)).toEqual(waveLayers(0));
  });

  it('draws the last figure alone at full load', () => {
    expect(waveLayers(1)).toEqual([{ ratio: WAVE_RATIOS[WAVE_RATIOS.length - 1], weight: 1 }]);
    expect(waveLayers(2)).toEqual(waveLayers(1));
  });

  it('splits the opacity between neighboring steps and never runs past the last', () => {
    for (let cpu = 0; cpu <= 1; cpu += 0.01) {
      const layers = waveLayers(cpu);
      const total = layers.reduce((sum, l) => sum + l.weight, 0);
      expect(total).toBeCloseTo(1);
      for (const l of layers) expect(WAVE_RATIOS).toContain(l.ratio);
    }
  });

  it('climbs linearly with load', () => {
    const half = waveLayers(0.5);
    const mid = (WAVE_RATIOS.length - 1) / 2;
    const lo = Math.floor(mid);
    expect(half[0].ratio).toEqual(WAVE_RATIOS[lo]);
    expect(half[1]?.weight ?? 0).toBeCloseTo(mid - lo);
  });

  it('climbs through coprime, unequal ratios with more lobes each step', () => {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    WAVE_RATIOS.forEach(([a, b], i) => {
      expect(a).not.toBe(b);
      expect(gcd(a, b)).toBe(1);
      if (i > 0) {
        const [pa, pb] = WAVE_RATIOS[i - 1];
        expect(a + b).toBeGreaterThan(pa + pb);
      }
    });
  });
});

describe('wavePoints', () => {
  it('returns n points inside the unit square', () => {
    const pts = wavePoints(WAVE_RATIOS[WAVE_RATIOS.length - 1], 1.2, 50);
    expect(pts).toHaveLength(50);
    for (const [x, y] of pts) {
      expect(Math.abs(x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y)).toBeLessThanOrEqual(1);
    }
  });

  it('closes the figure', () => {
    for (const ratio of WAVE_RATIOS) {
      const pts = wavePoints(ratio, 0.6, 100);
      expect(pts[99][0]).toBeCloseTo(pts[0][0]);
      expect(pts[99][1]).toBeCloseTo(pts[0][1]);
    }
  });
});

describe('phaseSpeed', () => {
  it('drifts at rest and speeds up with traffic', () => {
    expect(phaseSpeed(0)).toBeGreaterThan(0);
    expect(phaseSpeed(1)).toBeGreaterThan(phaseSpeed(0));
  });
});
