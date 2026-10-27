import { describe, expect, it } from 'vitest';
import { parseCollapsedSections, toggleSection } from './dashboardSections';

describe('parseCollapsedSections', () => {
  it('returns [] for non-arrays', () => {
    expect(parseCollapsedSections(undefined)).toEqual([]);
    expect(parseCollapsedSections(null)).toEqual([]);
    expect(parseCollapsedSections('panes')).toEqual([]);
    expect(parseCollapsedSections({ 0: 'panes' })).toEqual([]);
  });

  it('keeps every known name in order', () => {
    const all = ['repo', 'favorites', 'layouts', 'panes', 'containers', 'external'];
    expect(parseCollapsedSections(all)).toEqual(all);
    expect(parseCollapsedSections(['panes', 'repo'])).toEqual(['panes', 'repo']);
  });

  it('drops unknown names, non-strings, and duplicates', () => {
    expect(parseCollapsedSections(['panes', 'Panes', 'tabs', 3, null, 'panes', 'layouts'])).toEqual([
      'panes',
      'layouts',
    ]);
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
