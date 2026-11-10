import { describe, expect, it } from 'vitest';
import {
  cometCount,
  litPanes,
  loopRect,
  mostCrowded,
  perimeter,
  pointAt,
  tailAlpha,
  tailPoints,
  widestGapMidpoint,
} from './paneLightsModel';

const r = { x: 0, y: 0, w: 100, h: 50 };

describe('pointAt', () => {
  it('walks the loop clockwise from the top-left', () => {
    expect(pointAt(r, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(r, 40)).toEqual({ x: 40, y: 0 });
    expect(pointAt(r, 125)).toEqual({ x: 100, y: 25 });
    expect(pointAt(r, 160)).toEqual({ x: 90, y: 50 });
    expect(pointAt(r, 290)).toEqual({ x: 0, y: 10 });
  });

  it('wraps in both directions', () => {
    expect(pointAt(r, 300 + 40)).toEqual(pointAt(r, 40));
    expect(pointAt(r, -10)).toEqual({ x: 0, y: 10 });
  });
});

describe('loopRect', () => {
  it('pushes the pane out into the gutter', () => {
    expect(loopRect({ left: 10, top: 20, width: 100, height: 50 }, 2)).toEqual({ x: 8, y: 18, w: 104, h: 54 });
    expect(perimeter({ x: 8, y: 18, w: 104, h: 54 })).toBe(316);
  });
});

describe('tailPoints', () => {
  it('runs from one end through the head to the other, rounding the corner', () => {
    const pts = tailPoints(r, 110, 20, 5);
    expect(pts[0]).toEqual({ x: 90, y: 0, off: 20 });
    expect(pts).toContainEqual({ x: 100, y: 10, off: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 30, off: 20 });
    expect(pts.some((p) => p.x === 100 && p.y === 0)).toBe(true);
  });

  it('never runs longer than the loop', () => {
    const tiny = { x: 0, y: 0, w: 5, h: 5 };
    const pts = tailPoints(tiny, 0, 60, 3);
    expect(pts[0].off).toBe(10);
    expect(pts[pts.length - 1].off).toBe(10);
  });
});

describe('tailAlpha', () => {
  it('fades to nothing at the tail end', () => {
    expect(tailAlpha(0, 60, 0.3)).toBeCloseTo(0.4875);
    expect(tailAlpha(60, 60, 0.3)).toBe(0);
    expect(tailAlpha(80, 60, 0.3)).toBe(0);
  });
});

describe('litPanes', () => {
  it('lights every pane while none needs attention', () => {
    expect(litPanes(['a', 'b'], new Set())).toEqual(new Set(['a', 'b']));
  });

  it('lights only the panes that need attention', () => {
    expect(litPanes(['a', 'b', 'c'], new Set(['b', 'c']))).toEqual(new Set(['b', 'c']));
  });

  it('ignores attention on panes that are off screen', () => {
    expect(litPanes(['a', 'b'], new Set(['z']))).toEqual(new Set(['a', 'b']));
  });
});

describe('cometCount', () => {
  it('runs one comet per stretch of loop, and at least one', () => {
    expect(cometCount(300, 1500, 0, 0.15)).toBe(1);
    expect(cometCount(3000, 1500, 0, 0.15)).toBe(2);
    expect(cometCount(6000, 1500, 0, 0.15)).toBe(4);
  });

  it('holds the current count near a boundary', () => {
    // 2.6 rounds to 3, but a loop running 2 must reach 2.65 before it gains one.
    expect(cometCount(3900, 1500, 2, 0.15)).toBe(2);
    expect(cometCount(4000, 1500, 2, 0.15)).toBe(3);
    expect(cometCount(3600, 1500, 3, 0.15)).toBe(3);
    expect(cometCount(3300, 1500, 3, 0.15)).toBe(2);
  });
});

describe('widestGapMidpoint', () => {
  it('splits the widest gap, across the wrap too', () => {
    expect(widestGapMidpoint([0], 100)).toBe(50);
    expect(widestGapMidpoint([10, 30], 100)).toBe(70);
    expect(widestGapMidpoint([0, 60], 100)).toBe(30);
  });
});

describe('mostCrowded', () => {
  it('picks the comet whose neighbors sit closest', () => {
    expect(mostCrowded([0, 25, 30, 60], 100)).toBe(1);
    expect(mostCrowded([90, 5, 50], 100)).toBe(0);
  });
});
