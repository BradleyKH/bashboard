import { describe, expect, it } from 'vitest';
import { GALAXY_RADIUS, armOffset, dustAt } from './galaxyShape';
import { MAX_STARS, seedStars, starCountFor, starGain } from './galaxyStars';

describe('seedStars', () => {
  it('keeps the first stars in place when the count grows', () => {
    const small = seedStars(500);
    const large = seedStars(2000);
    expect(Array.from(large.position.slice(0, 1500))).toEqual(Array.from(small.position));
    expect(Array.from(large.hue.slice(0, 500))).toEqual(Array.from(small.hue));
  });

  it('keeps every star within the disc and every color channel in range', () => {
    const field = seedStars(5000);
    for (let i = 0; i < field.count; i++) {
      const [x, y, z] = field.position.slice(i * 3, i * 3 + 3);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(GALAXY_RADIUS * 1.05 + 1e-6);
      expect(Math.abs(y)).toBeLessThan(GALAXY_RADIUS * 0.3);
      expect(field.hue[i]).toBeGreaterThanOrEqual(0);
      expect(field.hue[i]).toBeLessThan(1);
      expect(field.brightness[i]).toBeGreaterThanOrEqual(0);
    }
    for (const v of [...field.shade, ...field.tint]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('hints at the arms while the swirl fills the disc between them', () => {
    const field = seedStars(6000);
    let outer = 0;
    let near = 0;
    let between = 0;
    for (let i = 0; i < field.count; i++) {
      const x = field.position[i * 3];
      const z = field.position[i * 3 + 2];
      if (Math.hypot(x, z) <= GALAXY_RADIUS * 0.3) continue;
      outer++;
      const off = Math.abs(armOffset(x, z));
      if (off < 0.3) near++;
      else if (off > 0.6) between++;
    }
    // The band within 0.3 rad of a spine is under 29 percent of the disc: it holds more than its
    // share of stars, but not most of them, and the band farthest from the arms is far from empty.
    expect(near / outer).toBeGreaterThan(0.36);
    expect(near / outer).toBeLessThan(0.55);
    expect(between / outer).toBeGreaterThan(0.18);
  });

  it('spreads the light evenly across the disc, with no hot core', () => {
    const field = seedStars(starCountFor(1000));
    const bands = new Array(9).fill(0);
    for (let i = 0; i < field.count; i++) {
      const r = Math.hypot(field.position[i * 3], field.position[i * 3 + 2]) / GALAXY_RADIUS;
      if (r < 0.9) bands[Math.floor(r * 10)] += field.brightness[i] * field.size[i] ** 2;
    }
    // Light per unit area in each ring, relative to the disc's middle.
    const perArea = bands.map((light, b) => light / (((b + 1) / 10) ** 2 - (b / 10) ** 2));
    const middle = (perArea[4] + perArea[5]) / 2;
    expect(perArea[0] / middle).toBeLessThan(3.5);
    for (const ring of perArea.slice(1)) {
      expect(ring / middle).toBeGreaterThan(0.5);
      expect(ring / middle).toBeLessThan(2);
    }
  });

  it('holds the summed star light near steady as the density changes', () => {
    expect(starGain(8000)).toBe(1);
    const total = (count: number) => count * starGain(count);
    expect(total(starCountFor(5000)) / total(starCountFor(300))).toBeLessThan(1.5);
    expect(total(starCountFor(5000)) / total(starCountFor(300))).toBeGreaterThan(1);
  });

  it('maps the density setting to a capped star count', () => {
    expect(starCountFor(1000)).toBe(8000);
    expect(starCountFor(5000)).toBe(MAX_STARS);
    expect(starCountFor(300)).toBe(2400);
  });
});

describe('dustAt', () => {
  it('is clear at the core and beyond the rim', () => {
    expect(dustAt(0, 0)).toBe(0);
    expect(dustAt(GALAXY_RADIUS * 1.2, 0)).toBe(0);
  });

  it('stays within 0..1 across the disc', () => {
    for (let x = -50; x <= 50; x += 2.5) {
      for (let z = -50; z <= 50; z += 2.5) {
        const d = dustAt(x, z);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
      }
    }
  });
});
