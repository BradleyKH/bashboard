import { describe, expect, it } from 'vitest';
import { SlideshowOrder } from './slideshowOrder';

const files = ['C:/p/a.png', 'C:/p/B.jpg', 'C:/p/c.webp'];

describe('SlideshowOrder in order', () => {
  it('starts at the first file and wraps', () => {
    const order = new SlideshowOrder();
    expect(order.next(files, undefined, false)).toBe(files[0]);
    expect(order.next(files, files[0], false)).toBe(files[1]);
    expect(order.next(files, files[2], false)).toBe(files[0]);
  });

  it('advances past a current file that was deleted', () => {
    const order = new SlideshowOrder();
    expect(order.next(['C:/p/a.png', 'C:/p/c.webp'], 'C:/p/B.jpg', false)).toBe('C:/p/c.webp');
  });

  it('returns undefined for an empty folder', () => {
    expect(new SlideshowOrder().next([], undefined, false)).toBeUndefined();
  });
});

describe('SlideshowOrder shuffled', () => {
  it('shows every file once per round and never repeats the current one', () => {
    let i = 0;
    const order = new SlideshowOrder(() => [0.99, 0, 0.5, 0, 0.7, 0.2][i++ % 6]);
    let current: string | undefined;
    const seen: string[] = [];
    for (let n = 0; n < 3; n++) {
      current = order.next(files, current, true);
      seen.push(current!);
    }
    expect([...seen].sort()).toEqual([...files].sort());
    for (let n = 0; n < 10; n++) {
      const next = order.next(files, current, true);
      expect(next).not.toBe(current);
      current = next;
    }
  });

  it('shows a single file repeatedly', () => {
    const order = new SlideshowOrder();
    expect(order.next(['a.png'], 'a.png', true)).toBe('a.png');
  });
});
