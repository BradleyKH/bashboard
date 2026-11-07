import { describe, expect, it } from 'vitest';
import {
  WAVE_DETUNE_MAX,
  WAVE_RATIOS,
  cpuLevel,
  detuneAt,
  detuneSpeed,
  ease,
  memLevel,
  netLevel,
  spinSpeed,
  waveExtent,
  waveFit,
  waveLayers,
  wavePoints,
} from './waveModel';

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
    const v = ease(0, 1, 1);
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

describe('memLevel', () => {
  it('is the used share, clamped', () => {
    expect(memLevel(4, 16)).toBe(0.25);
    expect(memLevel(20, 16)).toBe(1);
  });

  it('treats an unknown total as empty', () => {
    expect(memLevel(4, 0)).toBe(0);
    expect(memLevel(Number.NaN, 16)).toBe(0);
  });
});

describe('detune sweep', () => {
  const sweepSeconds = (mem: number) => Math.PI / detuneSpeed(mem);

  it('takes 20 s at 25% memory and 5 s at 100%', () => {
    expect(sweepSeconds(0.25)).toBeCloseTo(20);
    expect(sweepSeconds(1)).toBeCloseTo(5);
  });

  it('still moves with almost no memory in use', () => {
    expect(detuneSpeed(0)).toBeGreaterThan(0);
  });

  it('runs from 0 to the maximum over half a turn and back', () => {
    expect(detuneAt(0)).toBeCloseTo(0);
    expect(detuneAt(Math.PI)).toBeCloseTo(WAVE_DETUNE_MAX);
    expect(detuneAt(Math.PI * 2)).toBeCloseTo(0);
  });
});

describe('wavePoints', () => {
  const pose = { detune: 0.3, spin: 1.1, tilt: 2.3 };

  it('returns n points with depth in -1..1', () => {
    const pts = wavePoints(WAVE_RATIOS[WAVE_RATIOS.length - 1], pose, 50);
    expect(pts).toHaveLength(50);
    for (const [, , depth] of pts) expect(Math.abs(depth)).toBeLessThanOrEqual(1);
  });

  it('closes the figure without detune and leaves loose ends with it', () => {
    for (const ratio of WAVE_RATIOS) {
      const closed = wavePoints(ratio, { ...pose, detune: 0 }, 100);
      expect(closed[99][0]).toBeCloseTo(closed[0][0]);
      expect(closed[99][1]).toBeCloseTo(closed[0][1]);
      const open = wavePoints(ratio, { detune: 0.3, spin: 0, tilt: 0 }, 100);
      expect(Math.abs(open[99][0] - open[0][0])).toBeGreaterThan(0.5);
    }
  });
});

describe('waveFit', () => {
  it('fits every pose inside the box', () => {
    let fit: number | undefined;
    for (let k = 0; k < 200; k++) {
      const figure = wavePoints(WAVE_RATIOS[k % WAVE_RATIOS.length], { detune: (k % 7) / 10, spin: k * 0.37, tilt: k * 0.21 }, 120);
      fit = waveFit(fit, waveExtent([figure]), 0.05);
      expect(waveExtent([figure]) * fit).toBeLessThanOrEqual(1);
    }
  });

  it('shrinks at once and regrows slowly', () => {
    expect(waveFit(1, 2, 0.05)).toBeLessThan(0.5);
    const regrown = waveFit(0.5, 1, 0.05);
    expect(regrown).toBeGreaterThan(0.5);
    expect(regrown).toBeLessThan(0.55);
  });
});

describe('spinSpeed', () => {
  it('drifts at rest and speeds up with traffic', () => {
    expect(spinSpeed(0)).toBeGreaterThan(0);
    expect(spinSpeed(1)).toBeGreaterThan(spinSpeed(0));
  });
});
