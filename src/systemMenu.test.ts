import { describe, expect, it, vi } from 'vitest';
import { systemMenuItems, type SystemRowsShown } from './systemMenu';

const ALL: SystemRowsShown = { cpu: true, memory: true, network: true, disk: true };

describe('systemMenuItems', () => {
  it('lists a toggle per row with its state, then Hide system', () => {
    const entries = systemMenuItems({ ...ALL, network: false }, () => {}, () => {});
    expect(entries.map((e) => (e.kind === 'item' ? [e.label, e.checked] : e.kind))).toEqual([
      ['CPU', true],
      ['Memory', true],
      ['Network', false],
      ['Disk', true],
      'separator',
      ['Hide system', undefined],
    ]);
  });

  it('flips the chosen row and reports the hide', () => {
    const onSet = vi.fn();
    const onHide = vi.fn();
    const run = (shown: SystemRowsShown, label: string): void => {
      const e = systemMenuItems(shown, onSet, onHide).find((x) => x.kind === 'item' && x.label === label);
      if (e?.kind === 'item') e.run();
    };
    run(ALL, 'CPU');
    run({ ...ALL, disk: false }, 'Disk');
    run(ALL, 'Hide system');
    expect(onSet.mock.calls).toEqual([
      ['cpu', false],
      ['disk', true],
    ]);
    expect(onHide).toHaveBeenCalledOnce();
  });
});
