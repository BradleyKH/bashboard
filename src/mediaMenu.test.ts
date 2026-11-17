import { describe, expect, it, vi } from 'vitest';
import { mediaMenuItems, type MediaPartsShown } from './mediaMenu';

const ALL: MediaPartsShown = { art: true, title: true, artist: true };

describe('mediaMenuItems', () => {
  it('lists the art, title, and artist toggles with their state, then Hide media', () => {
    const entries = mediaMenuItems({ art: true, title: false, artist: true }, () => {}, () => {});
    expect(entries.map((e) => (e.kind === 'item' ? [e.label, e.checked] : e.kind))).toEqual([
      ['Show album art', true],
      ['Show title', false],
      ['Show artist', true],
      'separator',
      ['Hide media', undefined],
    ]);
  });

  it('flips the chosen part and reports the hide', () => {
    const onSet = vi.fn();
    const onHide = vi.fn();
    const run = (shown: MediaPartsShown, label: string): void => {
      const e = mediaMenuItems(shown, onSet, onHide).find((x) => x.kind === 'item' && x.label === label);
      if (e?.kind === 'item') e.run();
    };
    run(ALL, 'Show album art');
    run({ ...ALL, art: false }, 'Show album art');
    run(ALL, 'Show title');
    run({ ...ALL, artist: false }, 'Show artist');
    run(ALL, 'Hide media');
    expect(onSet.mock.calls).toEqual([
      ['art', false],
      ['art', true],
      ['title', false],
      ['artist', true],
    ]);
    expect(onHide).toHaveBeenCalledOnce();
  });
});
