import { describe, expect, it } from 'vitest';
import { bakeGas, bakeSky, seedSkyStars } from './galaxyBake';

describe('bakeGas', () => {
  it('is deterministic, opaque, and empty at its edges', () => {
    const size = 64;
    const a = bakeGas(size);
    expect(a).toEqual(bakeGas(size));
    for (let i = 3; i < a.length; i += 4) expect(a[i]).toBe(255);
    // The corners lie past the rim, where the gas has faded out.
    expect(a[0]).toBe(0);
    expect(a[(size * size - 1) * 4]).toBe(0);
  });

  it('has gas somewhere along the arms', () => {
    const a = bakeGas(64);
    let lit = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] > 40) lit++;
    expect(lit).toBeGreaterThan(64 * 64 * 0.03);
  });
});

describe('bakeSky', () => {
  it('matches across the longitude seam', () => {
    const w = 64;
    const h = 32;
    const sky = bakeSky(w, h);
    for (let j = 0; j < h; j++) {
      const first = sky[j * w * 4];
      const last = sky[(j * w + w - 1) * 4];
      expect(Math.abs(first - last)).toBeLessThan(40);
    }
  });
});

describe('seedSkyStars', () => {
  it('places unit directions', () => {
    const stars = seedSkyStars(200);
    for (let i = 0; i < stars.count; i++) {
      const [x, y, z] = stars.direction.slice(i * 3, i * 3 + 3);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
    }
  });
});
