import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ELEMENT_ORDER,
  parseCollapsedSections,
  parseSectionOrder,
  parseTopElements,
  placeElement,
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
    const all = ['pins', 'folder', 'favorites', 'layouts', 'panes', 'containers', 'external', 'system'];
    expect(parseCollapsedSections(all)).toEqual(all);
    expect(parseCollapsedSections(['panes', 'folder'])).toEqual(['panes', 'folder']);
  });

  it('reads the older repo name as folder', () => {
    expect(parseCollapsedSections(['repo', 'pins'])).toEqual(['folder', 'pins']);
    expect(parseCollapsedSections(['folder', 'repo'])).toEqual(['folder']);
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
    expect(toggleSection(['folder'], 'panes')).toEqual(['folder', 'panes']);
  });

  it('removes a present section without mutating the input', () => {
    const list = ['folder' as const, 'panes' as const];
    expect(toggleSection(list, 'folder')).toEqual(['panes']);
    expect(list).toEqual(['folder', 'panes']);
  });
});

describe('DEFAULT_ELEMENT_ORDER', () => {
  it('puts the clock and Folder first and System after External sessions', () => {
    expect([...DEFAULT_ELEMENT_ORDER]).toEqual([
      'clock',
      'folder',
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
      'folder',
      'favorites',
      'layouts',
      'panes',
      'containers',
    ]);
  });

  it('keeps a saved custom order', () => {
    const custom: DashboardElement[] = [
      'clock',
      'folder',
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
    expect(parseSectionOrder(['clock', 'folder', 'favorites', 'layouts', 'containers', 'external', 'system'])).toEqual([
      'clock',
      'folder',
      'favorites',
      'layouts',
      'panes',
      'containers',
      'external',
      'system',
    ]);
  });

  it('puts a missing first element at index 0', () => {
    expect(parseSectionOrder(['folder', 'favorites', 'layouts', 'panes', 'containers', 'external', 'system'])).toEqual(def);
    expect(parseSectionOrder(['folder', 'layouts', 'favorites', 'panes', 'containers', 'external', 'system'])).toEqual([
      'clock',
      'folder',
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
      'folder',
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
    expect(parseSectionOrder(['clock', 'folder', 'favorites', 'layouts', 'panes', 'containers', 'external'])).toEqual(def);
    expect(parseSectionOrder(['favorites', 'layouts', 'panes', 'containers', 'external', 'clock', 'folder'])).toEqual([
      'favorites',
      'layouts',
      'panes',
      'containers',
      'external',
      'system',
      'clock',
      'folder',
    ]);
  });

  it('puts Folder after the clock in an order saved before it existed', () => {
    const old = ['panes', 'clock', 'favorites', 'layouts', 'containers', 'external', 'system'];
    expect(parseSectionOrder(old).indexOf('folder')).toBe(2);
  });
});

describe('placeElement', () => {
  const order: DashboardElement[] = ['favorites', 'layouts', 'panes', 'containers', 'external', 'clock'];

  it('moves within the list', () => {
    expect(placeElement(order, [], 'panes', 'list', 'favorites')).toEqual({
      order: ['panes', 'favorites', 'layouts', 'containers', 'external', 'clock'],
      top: [],
    });
    expect(placeElement(order, [], 'favorites', 'list', null).order).toEqual([
      'layouts',
      'panes',
      'containers',
      'external',
      'clock',
      'favorites',
    ]);
  });

  it('moves any element into the top slot, ahead of the list', () => {
    expect(placeElement(order, [], 'panes', 'top', null)).toEqual({
      order: ['panes', 'favorites', 'layouts', 'containers', 'external', 'clock'],
      top: ['panes'],
    });
  });

  it('adds to the end of the top slot or before one of its elements', () => {
    expect(placeElement(order, ['clock'], 'layouts', 'top', null)).toEqual({
      order: ['clock', 'layouts', 'favorites', 'panes', 'containers', 'external'],
      top: ['clock', 'layouts'],
    });
    expect(placeElement(order, ['clock'], 'layouts', 'top', 'clock')).toEqual({
      order: ['layouts', 'clock', 'favorites', 'panes', 'containers', 'external'],
      top: ['layouts', 'clock'],
    });
  });

  it('moves out of the top slot into the list', () => {
    expect(placeElement(['clock', 'panes', 'favorites'], ['clock', 'panes'], 'clock', 'list', null)).toEqual({
      order: ['panes', 'favorites', 'clock'],
      top: ['panes'],
    });
  });

  it('keeps a disabled top element in the top slot', () => {
    // System is in the top slot but hidden, so the panel drops after Clock with before null.
    expect(placeElement(['system', 'clock', 'panes'], ['system', 'clock'], 'panes', 'top', null)).toEqual({
      order: ['system', 'clock', 'panes'],
      top: ['system', 'clock', 'panes'],
    });
  });

  it('leaves everything equal when dropped on its own place', () => {
    expect(placeElement(order, ['clock'], 'panes', 'list', 'panes')).toEqual({ order, top: ['clock'] });
  });

  it('does not mutate the input', () => {
    const copy = [...order];
    const top: DashboardElement[] = ['clock'];
    placeElement(order, top, 'favorites', 'top', null);
    expect(order).toEqual(copy);
    expect(top).toEqual(['clock']);
  });
});

describe('parseTopElements', () => {
  it('keeps known names once each and rejects a non-array', () => {
    expect(parseTopElements(['panes', 'repo', 'panes', 3, 'clock'])).toEqual(['panes', 'clock']);
    expect(parseTopElements([])).toEqual([]);
    expect(parseTopElements('clock')).toBeNull();
  });
});
