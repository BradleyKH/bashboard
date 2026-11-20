import { describe, expect, it } from 'vitest';
import { kindIconShapes } from './kindIconShapes';
import { PANE_KINDS, SHIP_ICON } from './paneKinds';

describe('kindIconShapes', () => {
  it('draws every pane kind but Ship, which has its rocket', () => {
    for (const info of PANE_KINDS) {
      if (info.kind === 'ship') expect(kindIconShapes(info.icon)).toBeNull();
      else expect(kindIconShapes(info.icon)?.length, info.kind).toBeGreaterThan(0);
    }
    expect(kindIconShapes(SHIP_ICON)).toBeNull();
  });

  it('leaves other glyphs as text', () => {
    expect(kindIconShapes('>_')).toBeNull();
    expect(kindIconShapes('')).toBeNull();
  });
});
