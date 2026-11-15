import { describe, expect, it, vi } from 'vitest';
import { mediaMenuItems } from './mediaMenu';

describe('mediaMenuItems', () => {
  it('lists Show album art with its state, then Hide media', () => {
    const entries = mediaMenuItems(true, () => {}, () => {});
    expect(entries.map((e) => (e.kind === 'item' ? [e.label, e.checked] : e.kind))).toEqual([
      ['Show album art', true],
      'separator',
      ['Hide media', undefined],
    ]);
  });

  it('flips the art and reports the hide', () => {
    const onArt = vi.fn();
    const onHide = vi.fn();
    const run = (entries: ReturnType<typeof mediaMenuItems>, label: string): void => {
      const e = entries.find((x) => x.kind === 'item' && x.label === label);
      if (e?.kind === 'item') e.run();
    };
    run(mediaMenuItems(true, onArt, onHide), 'Show album art');
    run(mediaMenuItems(false, onArt, onHide), 'Show album art');
    run(mediaMenuItems(false, onArt, onHide), 'Hide media');
    expect(onArt.mock.calls).toEqual([[false], [true]]);
    expect(onHide).toHaveBeenCalledOnce();
  });
});
