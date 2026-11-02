import { describe, expect, it } from 'vitest';
import { createRng } from '../sim/rng';
import { GLYPHS, MatrixRain } from './matrixModel';

function makeRain(seed = 1, w = 200, h = 100, cell = 20): MatrixRain {
  const rain = new MatrixRain(createRng(seed));
  rain.resize(w, h, cell);
  return rain;
}

describe('GLYPHS', () => {
  it('has no spaces or control characters', () => {
    for (const ch of GLYPHS) expect(ch.charCodeAt(0)).toBeGreaterThan(0x20);
  });
});

describe('MatrixRain', () => {
  it('derives the grid from size and cell size', () => {
    const rain = makeRain(1, 205, 100, 20);
    expect(rain.cols).toBe(11);
    expect(rain.rows).toBe(5);
  });

  it('only emits glyphs from GLYPHS, inside the grid', () => {
    const rain = makeRain();
    for (let i = 0; i < 200; i++) {
      for (const g of rain.step()) {
        expect(GLYPHS).toContain(g.char);
        expect(g.col).toBeGreaterThanOrEqual(0);
        expect(g.col).toBeLessThan(rain.cols);
        expect(g.row).toBeGreaterThanOrEqual(0);
        expect(g.row).toBeLessThan(rain.rows);
      }
    }
  });

  it('redraws the previous head cell as a non-head with the same char', () => {
    const rain = makeRain(3);
    let prevHeads = new Map<number, { row: number; char: string }>();
    for (let i = 0; i < 100; i++) {
      const glyphs = rain.step();
      for (const [col, h] of prevHeads) {
        const trail = glyphs.find((g) => g.col === col && !g.head);
        if (trail && trail.row === h.row) expect(trail.char).toBe(h.char);
      }
      prevHeads = new Map(glyphs.filter((g) => g.head).map((g) => [g.col, { row: g.row, char: g.char }]));
    }
  });

  it('restarts every column from the top after its drop passes the bottom', () => {
    const rain = makeRain(5, 60, 100, 20);
    const lastHead = new Map<number, number>();
    const resets = new Set<number>();
    // The chance of a column staying idle this long at density 1 is far below one in a million.
    for (let i = 0; i < rain.rows * 2 + 600; i++) {
      for (const g of rain.step()) {
        if (!g.head) continue;
        const last = lastHead.get(g.col);
        if (last !== undefined && g.row < last) {
          expect(g.row).toBe(0);
          resets.add(g.col);
        }
        lastHead.set(g.col, g.row);
      }
    }
    expect(resets.size).toBe(rain.cols);
  });

  it('staggers columns', () => {
    const rain = makeRain(7, 400, 400, 20);
    const first = rain.step().filter((g) => g.head).length;
    expect(first).toBeLessThan(rain.cols);
  });

  it('starts drops more often at a higher density', () => {
    const starts = (density: number): number => {
      const rain = makeRain(11, 2000, 200, 20);
      rain.setDensity(density);
      let n = 0;
      for (let i = 0; i < 500; i++) n += rain.step().filter((g) => g.head && g.row === 0).length;
      return n;
    };
    const sparse = starts(0.25);
    const normal = starts(1);
    const dense = starts(4);
    expect(sparse).toBeGreaterThan(0);
    expect(normal).toBeGreaterThan(sparse * 2);
    expect(dense).toBeGreaterThan(normal * 2);
  });

  it('keeps surviving columns on resize', () => {
    const a = makeRain(9, 200, 100, 20);
    const b = makeRain(9, 200, 100, 20);
    for (let i = 0; i < 7; i++) {
      a.step();
      b.step();
    }
    b.resize(100, 100, 20);
    expect(b.cols).toBe(5);
    const fromA = a.step().filter((g) => g.col < 5);
    const fromB = b.step();
    // Same rows in the surviving columns; only the chars differ, since they share one rng.
    const key = (g: { col: number; row: number; head: boolean }) => `${g.col}:${g.row}:${g.head}`;
    expect(fromB.map(key)).toEqual(fromA.map(key));
    b.resize(300, 100, 20);
    expect(b.cols).toBe(15);
    expect(b.step().every((g) => g.col < 15)).toBe(true);
  });

  it('is deterministic for a seeded random', () => {
    const run = () => {
      const rain = makeRain(42);
      const out = [];
      for (let i = 0; i < 50; i++) out.push(rain.step());
      return out;
    };
    expect(run()).toEqual(run());
  });
});
