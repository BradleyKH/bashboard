import { describe, expect, it, vi } from 'vitest';
import { clockMenuItems } from './clockMenu';

describe('clockMenuItems', () => {
  it('lists the styles with the current one checked, then Hide clock', () => {
    const entries = clockMenuItems('time', () => {}, () => {});
    expect(entries.map((e) => (e.kind === 'item' ? [e.label, e.checked] : e.kind))).toEqual([
      ['Binary and time', false],
      ['Time only', true],
      ['Binary only', false],
      'separator',
      ['Hide clock', undefined],
    ]);
  });

  it('reports the chosen style or the hide', () => {
    const onStyle = vi.fn();
    const onHide = vi.fn();
    const entries = clockMenuItems('both', onStyle, onHide);
    const run = (label: string): void => {
      const e = entries.find((x) => x.kind === 'item' && x.label === label);
      if (e?.kind === 'item') e.run();
    };
    run('Binary only');
    run('Hide clock');
    expect(onStyle.mock.calls).toEqual([['binary']]);
    expect(onHide).toHaveBeenCalledOnce();
  });
});
