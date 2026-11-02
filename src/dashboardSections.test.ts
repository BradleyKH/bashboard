import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ELEMENT_ORDER,
  moveSection,
  parseCollapsedSections,
  parseSectionOrder,
  toggleSection,
  type DashboardElement,
} from './dashboardSections';

describe('parseCollapsedSections', () => {
  it('returns [] for non-arrays', () => {
    expect(parseCollapsedSections(undefined)).toEqual([]);
    expect(parseCollapsedSections(null)).toEqual([]);
    expect(parseCollapsedSections('panes')).toEqual([]);
    expect(parseCollapsedSections({ 0: 'panes' })).toEqual([]);
  });

  it('keeps every known name in order', () => {
    const all = ['repo', 'favorites', 'layouts', 'panes', 'containers', 'external', 'system'];
    expect(parseCollapsedSections(all)).toEqual(all);
    expect(parseCollapsedSections(['panes', 'repo'])).toEqual(['panes', 'repo']);
  });

  it('drops unknown names, non-strings, and duplicates', () => {
    expect(parseCollapsedSections(['panes', 'Panes', 'tabs', 3, null, 'panes', 'layouts'])).toEqual([
      'panes',
      'layouts',
    ]);
  });

  it('drops the clock, which is never collapsible', () => {
    expect(parseCollapsedSections(['clock'])).toEqual([]);
    expect(parseCollapsedSections(['panes', 'clock'])).toEqual(['panes']);
  });
});

describe('toggleSection', () => {
  it('adds an absent section at the end', () => {
    expect(toggleSection(['repo'], 'panes')).toEqual(['repo', 'panes']);
  });

  it('removes a present section without mutating the input', () => {
    const list = ['repo' as const, 'panes' as const];
    expect(toggleSection(list, 'repo')).toEqual(['panes']);
    expect(list).toEqual(['repo', 'panes']);
  });
});

describe('DEFAULT_ELEMENT_ORDER', () => {
  it('puts the clock first and System after External sessions', () => {
    expect([...DEFAULT_ELEMENT_ORDER]).toEqual([
      'clock',
      'favorites',
      'layouts',
      'panes',
      'containers',
      'external',
      'system',
    ]);
  });
});

describe('parseSectionOrder', () => {
  const def = [...DEFAULT_ELEMENT_ORDER];

  it('gives the default for non-arrays and an empty array', () => {
    for (const raw of [undefined, null, 'panes', { 0: 'panes' }, []]) {
      expect(parseSectionOrder(raw)).toEqual(def);
    }
  });

  it('returns a copy, not the default array itself', () => {
    expect(parseSectionOrder(undefined)).not.toBe(DEFAULT_ELEMENT_ORDER);
  });

  it('drops unknown names, non-strings, duplicates, and repo', () => {
    const raw = ['external', 'repo', 'tabs', 3, null, 'external', 'clock', 'favorites', 'layouts', 'panes', 'containers'];
    expect(parseSectionOrder(raw)).toEqual([
      'external',
      'system',
      'clock',
      'favorites',
      'layouts',
      'panes',
      'containers',
    ]);
  });

  it('keeps a saved custom order', () => {
    const custom: DashboardElement[] = [
      'clock',
      'system',
      'external',
      'containers',
      'panes',
      'layouts',
      'favorites',
    ];
    expect(parseSectionOrder(custom)).toEqual(custom);
  });

  it('inserts one missing element after its nearest default predecessor', () => {
    expect(parseSectionOrder(['clock', 'favorites', 'layouts', 'containers', 'external', 'system'])).toEqual([
      'clock',
      'favorites',
      'layouts',
      'panes',
      'containers',
      'external',
      'system',
    ]);
  });

  it('puts a missing first element at index 0', () => {
    expect(parseSectionOrder(['favorites', 'layouts', 'panes', 'containers', 'external', 'system'])).toEqual(def);
    expect(parseSectionOrder(['layouts', 'favorites', 'panes', 'containers', 'external', 'system'])).toEqual([
      'clock',
      'layouts',
      'favorites',
      'panes',
      'containers',
      'external',
      'system',
    ]);
  });

  it('inserts several missing elements, later ones anchoring on earlier inserted ones', () => {
    expect(parseSectionOrder(['external', 'layouts'])).toEqual([
      'clock',
      'favorites',
      'external',
      'system',
      'layouts',
      'panes',
      'containers',
    ]);
    expect(parseSectionOrder(['clock'])).toEqual(def);
  });

  it('places System after External sessions in an order saved before it existed', () => {
    expect(parseSectionOrder(['clock', 'favorites', 'layouts', 'panes', 'containers', 'external'])).toEqual(def);
    expect(parseSectionOrder(['favorites', 'layouts', 'panes', 'containers', 'external', 'clock'])).toEqual([
      'favorites',
      'layouts',
      'panes',
      'containers',
      'external',
      'system',
      'clock',
    ]);
  });
});

describe('moveSection', () => {
  const order: DashboardElement[] = ['favorites', 'layouts', 'panes', 'containers', 'external', 'clock'];

  it('moves to the top', () => {
    expect(moveSection(order, 'panes', 'favorites')).toEqual([
      'panes',
      'favorites',
      'layouts',
      'containers',
      'external',
      'clock',
    ]);
  });

  it('moves to the bottom when before is null', () => {
    expect(moveSection(order, 'favorites', null)).toEqual([
      'layouts',
      'panes',
      'containers',
      'external',
      'clock',
      'favorites',
    ]);
  });

  it('moves before an element in the middle', () => {
    expect(moveSection(order, 'clock', 'layouts')).toEqual([
      'favorites',
      'clock',
      'layouts',
      'panes',
      'containers',
      'external',
    ]);
  });

  it('leaves the order equal when dropped on its own place', () => {
    expect(moveSection(order, 'panes', 'panes')).toEqual(order);
    expect(moveSection(order, 'panes', 'containers')).toEqual(order);
    expect(moveSection(order, 'clock', null)).toEqual(order);
  });

  it('does not mutate the input', () => {
    const copy = [...order];
    const out = moveSection(order, 'clock', 'favorites');
    expect(order).toEqual(copy);
    expect(out).not.toBe(order);
  });
});
