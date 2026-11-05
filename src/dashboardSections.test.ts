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
    const all = ['pins', 'favorites', 'layouts', 'panes', 'containers', 'ports', 'external', 'system'];
    expect(parseCollapsedSections(all)).toEqual(all);
    expect(parseCollapsedSections(['panes', 'pins'])).toEqual(['panes', 'pins']);
  });

  it('drops Launch and its earlier names, which never collapse', () => {
    expect(parseCollapsedSections(['repo', 'pins', 'folder', 'launch'])).toEqual(['pins']);
  });

  it('drops unknown names, non-strings, and duplicates', () => {
    expect(parseCollapsedSections(['panes', 'Panes', 'tabs', 3, null, 'panes', 'layouts'])).toEqual([
      'panes',
      'layouts',
    ]);
  });

  it('drops the clock and Wave, which are never collapsible', () => {
    expect(parseCollapsedSections(['clock', 'wave'])).toEqual([]);
    expect(parseCollapsedSections(['panes', 'clock'])).toEqual(['panes']);
  });
});

describe('toggleSection', () => {
  it('adds an absent section at the end', () => {
    expect(toggleSection(['pins'], 'panes')).toEqual(['pins', 'panes']);
  });

  it('removes a present section without mutating the input', () => {
    const list = ['pins' as const, 'panes' as const];
    expect(toggleSection(list, 'pins')).toEqual(['panes']);
    expect(list).toEqual(['pins', 'panes']);
  });
});

describe('DEFAULT_ELEMENT_ORDER', () => {
  it('puts the clock and Launch first and System after External sessions', () => {
    expect([...DEFAULT_ELEMENT_ORDER]).toEqual([
      'clock',
      'launch',
      'favorites',
      'layouts',
      'panes',
      'containers',
      'ports',
      'localModels',
      'external',
      'system',
      'wave',
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

  it('drops unknown names, non-strings, and duplicates', () => {
    const raw = ['external', 'tabs', 3, null, 'external', 'clock', 'favorites', 'layouts', 'panes', 'containers'];
    expect(parseSectionOrder(raw)).toEqual([
      'external',
      'system',
      'wave',
      'clock',
      'launch',
      'favorites',
      'layouts',
      'panes',
      'containers',
      'ports',
      'localModels',
    ]);
  });

  it('reads Launch saved under its earlier names, folder and repo', () => {
    const saved = ['panes', 'folder', 'clock', 'favorites', 'layouts', 'containers', 'external', 'system'];
    expect(parseSectionOrder(saved).slice(0, 3)).toEqual(['panes', 'launch', 'clock']);
    expect(parseSectionOrder(['repo', 'folder', 'panes']).slice(0, 3)).toEqual(['clock', 'launch', 'favorites']);
  });

  it('keeps a saved custom order', () => {
    const custom: DashboardElement[] = [
      'clock',
      'launch',
      'wave',
      'system',
      'external',
      'ports',
      'localModels',
      'containers',
      'panes',
      'layouts',
      'favorites',
    ];
    expect(parseSectionOrder(custom)).toEqual(custom);
  });

  it('inserts one missing element after its nearest default predecessor', () => {
    expect(
      parseSectionOrder(['clock', 'launch', 'favorites', 'layouts', 'containers', 'ports', 'external', 'system', 'wave']),
    ).toEqual(def);
  });

  it('puts a missing first element at index 0', () => {
    const rest = ['panes', 'containers', 'ports', 'localModels', 'external', 'system', 'wave'];
    expect(parseSectionOrder(['launch', 'favorites', 'layouts', ...rest])).toEqual(def);
    expect(parseSectionOrder(['launch', 'layouts', 'favorites', ...rest])).toEqual([
      'clock',
      'launch',
      'layouts',
      'favorites',
      ...rest,
    ]);
  });

  it('inserts several missing elements, later ones anchoring on earlier inserted ones', () => {
    expect(parseSectionOrder(['external', 'layouts'])).toEqual([
      'clock',
      'launch',
      'favorites',
      'external',
      'system',
      'wave',
      'layouts',
      'panes',
      'containers',
      'ports',
      'localModels',
    ]);
    expect(parseSectionOrder(['clock'])).toEqual(def);
  });

  it('places System after External sessions in an order saved before it existed', () => {
    expect(parseSectionOrder(['clock', 'launch', 'favorites', 'layouts', 'panes', 'containers', 'external'])).toEqual(def);
    expect(parseSectionOrder(['favorites', 'layouts', 'panes', 'containers', 'external', 'clock', 'launch'])).toEqual([
      'favorites',
      'layouts',
      'panes',
      'containers',
      'ports',
      'localModels',
      'external',
      'system',
      'wave',
      'clock',
      'launch',
    ]);
  });

  it('puts Launch after the clock in an order saved before it existed', () => {
    const old = ['panes', 'clock', 'favorites', 'layouts', 'containers', 'external', 'system'];
    expect(parseSectionOrder(old).indexOf('launch')).toBe(2);
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
    expect(parseTopElements(['panes', 'tabs', 'panes', 3, 'clock'])).toEqual(['panes', 'clock']);
    expect(parseTopElements(['clock', 'folder'])).toEqual(['clock', 'launch']);
    expect(parseTopElements([])).toEqual([]);
    expect(parseTopElements('clock')).toBeNull();
  });
});
