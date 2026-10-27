import { describe, expect, it } from 'vitest';
import { type Layout } from './layout';
import { PaneZoom, canZoom } from './zoom';

const pane = (paneId: string): Layout => ({ kind: 'pane', paneId });
const row = (a: Layout, b: Layout): Layout => ({ kind: 'split', dir: 'row', ratio: 0.5, a, b });

describe('canZoom', () => {
  it('needs a split containing the focused pane', () => {
    expect(canZoom(row(pane('a'), pane('b')), 'a')).toBe(true);
    expect(canZoom(row(pane('a'), pane('b')), 'x')).toBe(false);
  });

  it('is false for one pane or no tree', () => {
    expect(canZoom(pane('a'), 'a')).toBe(false);
    expect(canZoom(null, 'a')).toBe(false);
  });
});

describe('PaneZoom', () => {
  it('zooms the focused pane and toggling again restores', () => {
    const z = new PaneZoom();
    const tree = row(pane('a'), pane('b'));
    expect(z.toggle('t1', tree, 'a')).toBe(true);
    expect(z.zoomed('t1', tree, 'a')).toBe('a');
    expect(z.toggle('t1', tree, 'a')).toBe(true);
    expect(z.zoomed('t1', tree, 'a')).toBeNull();
  });

  it('is per tab', () => {
    const z = new PaneZoom();
    const t1 = row(pane('a'), pane('b'));
    const t2 = row(pane('c'), pane('d'));
    z.toggle('t1', t1, 'a');
    expect(z.zoomed('t2', t2, 'c')).toBeNull();
    z.toggle('t2', t2, 'c');
    z.toggle('t1', t1, 'a');
    expect(z.zoomed('t1', t1, 'a')).toBeNull();
    expect(z.zoomed('t2', t2, 'c')).toBe('c');
  });

  it('ends when the tree is a new object, even if equal', () => {
    const z = new PaneZoom();
    const tree = row(pane('a'), pane('b'));
    z.toggle('t1', tree, 'a');
    expect(z.zoomed('t1', row(pane('a'), pane('b')), 'a')).toBeNull();
    expect(z.zoomed('t1', tree, 'a')).toBeNull();
  });

  it('ends when focus moves', () => {
    const z = new PaneZoom();
    const tree = row(pane('a'), pane('b'));
    z.toggle('t1', tree, 'a');
    expect(z.zoomed('t1', tree, 'b')).toBeNull();
    expect(z.zoomed('t1', tree, 'a')).toBeNull();
  });

  it('cannot zoom a single pane or an empty tree', () => {
    const z = new PaneZoom();
    expect(z.toggle('t1', pane('a'), 'a')).toBe(false);
    expect(z.toggle('t1', null, 'a')).toBe(false);
    expect(z.zoomed('t1', pane('a'), 'a')).toBeNull();
  });

  it('end and forget drop the zoom', () => {
    const z = new PaneZoom();
    const tree = row(pane('a'), pane('b'));
    z.toggle('t1', tree, 'a');
    expect(z.end('t1')).toBe(true);
    expect(z.end('t1')).toBe(false);
    expect(z.zoomed('t1', tree, 'a')).toBeNull();
    z.toggle('t1', tree, 'a');
    z.forget('t1');
    expect(z.zoomed('t1', tree, 'a')).toBeNull();
  });
});
