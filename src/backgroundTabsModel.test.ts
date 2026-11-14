import { describe, expect, it } from 'vitest';
import {
  CLUSTER_GAP_PX,
  clusterDepth,
  clusterHome,
  clusterPanes,
  clusterScale,
  driftPlan,
  driftTime,
  clusterLayout,
  rectTransform,
  recedeLeg,
  riseLeg,
  seedOf,
  type BackgroundTab,
} from './backgroundTabsModel';
import type { Layout, Rect } from './layout';

const AREA: Rect = { x: 8, y: 8, width: 1600, height: 900 };
const leaf = (paneId: string): Layout => ({ kind: 'pane', paneId });
const tab = (id: string, tree: Layout | null, panes: string[] = []): BackgroundTab => ({ id, tree, panes });

const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - 0.01 &&
  inner.y >= outer.y - 0.01 &&
  inner.x + inner.width <= outer.x + outer.width + 0.01 &&
  inner.y + inner.height <= outer.y + outer.height + 0.01;

describe('clusterLayout', () => {
  it('places every tab but the active one, each inside the pane area', () => {
    const tabs = ['t1', 't2', 't3', 't4'].map((id, i) => tab(id, leaf(`p${i}`)));
    const out = clusterLayout(tabs, 't2', AREA);
    expect(out.map((c) => c.tabId)).toEqual(['t1', 't3', 't4']);
    for (const c of out) expect(inside(c.rect, AREA), c.tabId).toBe(true);
  });

  it('keeps a tab at the same home whichever tab is active', () => {
    const tabs = ['t1', 't2', 't3'].map((id, i) => tab(id, leaf(`p${i}`)));
    const a = clusterLayout(tabs, 't1', AREA).find((c) => c.tabId === 't3');
    const b = clusterLayout(tabs, 't2', AREA).find((c) => c.tabId === 't3');
    expect(a?.rect).toEqual(b?.rect);
  });

  it('gives a tab with no panes no cluster', () => {
    const out = clusterLayout([tab('t1', leaf('p1')), tab('t2', null, [])], 't1', AREA);
    expect(out).toEqual([]);
  });

  it('keeps clusters apart from each other', () => {
    const tabs = Array.from({ length: 6 }, (_, i) => tab(`t${i}`, leaf(`p${i}`)));
    const out = clusterLayout(tabs, 't0', AREA);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i].rect;
        const b = out[j].rect;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `${out[i].tabId} ${out[j].tabId}`).toBe(false);
      }
    }
  });
});

describe('clusterScale and clusterHome', () => {
  it('shrinks clusters as tabs are added, down to a floor', () => {
    expect(clusterScale(2)).toBeGreaterThan(clusterScale(6));
    expect(clusterScale(40)).toBe(0.16);
  });

  it('starts at the top left', () => {
    const home = clusterHome(0, 4, AREA, { width: 300, height: 200 });
    expect(home.x + home.width / 2).toBeLessThan(AREA.x + AREA.width / 2);
    expect(home.y + home.height / 2).toBeLessThan(AREA.y + AREA.height / 2);
  });
});

describe('clusterPanes', () => {
  const box: Rect = { x: 100, y: 50, width: 400, height: 200 };

  it('lays the split tree out inside the box with a gap between panes', () => {
    const tree: Layout = { kind: 'split', dir: 'row', ratio: 0.5, a: leaf('a'), b: leaf('b') };
    const panes = clusterPanes(tab('t', tree), box);
    const a = panes.get('a')!;
    const b = panes.get('b')!;
    expect(inside(a, box) && inside(b, box)).toBe(true);
    expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(CLUSTER_GAP_PX);
  });

  it('lines collapsed panes up in a row when the tree is empty', () => {
    const panes = clusterPanes(tab('t', null, ['a', 'b', 'c']), box);
    const ys = [...panes.values()].map((r) => r.y);
    expect(new Set(ys).size).toBe(1);
    expect([...panes.keys()]).toEqual(['a', 'b', 'c']);
  });
});

describe('clusterDepth', () => {
  it('brings a tab that needs you forward and sinks an idle one', () => {
    expect(clusterDepth(true, 'idle')).toBe('forward');
    expect(clusterDepth(false, 'waiting')).toBe('forward');
    expect(clusterDepth(false, 'idle')).toBe('back');
    expect(clusterDepth(false, 'working')).toBe('rest');
  });
});

describe('driftPlan', () => {
  const home: Rect = { x: 40, y: 30, width: 300, height: 200 };
  const offsets = (plan: ReturnType<typeof driftPlan>): Array<[number, number]> =>
    plan.keyframes.map((k) => {
      const [, dx, dy] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(k.transform))!;
      return [Number(dx), Number(dy)];
    });

  it('is a closed loop that keeps the cluster inside the area', () => {
    for (const id of ['t1', 't2', 't3', 't4', 't5']) {
      const plan = driftPlan(seedOf(id), home, AREA);
      expect(plan.keyframes[plan.keyframes.length - 1].transform).toBe(plan.keyframes[0].transform);
      for (const [dx, dy] of offsets(plan)) {
        expect(inside({ ...home, x: home.x + dx, y: home.y + dy }, AREA), id).toBe(true);
      }
      expect(plan.options.iterations).toBe(Infinity);
    }
  });

  it('roams across most of the area', () => {
    const xs = offsets(driftPlan(seedOf('t3'), home, AREA)).map(([dx]) => dx);
    const span = Math.max(...xs) - Math.min(...xs);
    expect(span).toBeGreaterThan((AREA.width - home.width) * 0.7);
  });

  it('is the same for the same tab and differs between tabs', () => {
    expect(driftPlan(seedOf('t1'), home, AREA)).toEqual(driftPlan(seedOf('t1'), home, AREA));
    expect(driftPlan(seedOf('t1'), home, AREA)).not.toEqual(driftPlan(seedOf('t2'), home, AREA));
  });
});

describe('driftTime', () => {
  it('follows the clock within one loop', () => {
    const seed = seedOf('t1');
    const a = driftTime(seed, 80_000, 1_000);
    expect(driftTime(seed, 80_000, 6_000)).toBe((a + 5_000) % 80_000);
    expect(driftTime(seed, 80_000, 1_000 + 80_000)).toBe(a);
  });
});

describe('legs', () => {
  const rest: Rect = { x: 0, y: 0, width: 800, height: 600 };
  const spot: Rect = { x: 40, y: 30, width: 200, height: 150 };

  it('maps a rect onto another', () => {
    expect(rectTransform(rest, spot)).toBe('translate(40.00px, 30.00px) scale(0.2500, 0.2500)');
  });

  it('recedes from rest into the spot and rises from the spot to rest', () => {
    expect(recedeLeg(rest, spot).keyframes[1]?.transform).toBe(rectTransform(rest, spot));
    expect(riseLeg(spot, rest).keyframes[0].transform).toBe(rectTransform(rest, spot));
    expect(riseLeg(spot, rest).keyframes[1]?.transform).toBe('none');
  });
});
