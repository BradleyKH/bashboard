import { describe, expect, it, vi } from 'vitest';
import { dashboardMenuItems } from './dashboardMenu';
import { SHOWABLE_ORDER, ELEMENT_LABELS, ELEMENT_SHOWN_BY_DEFAULT } from './dashboardSections';

describe('dashboardMenuItems', () => {
  it('lists every element and Pins in settings order, checked when shown', () => {
    const entries = dashboardMenuItems(ELEMENT_SHOWN_BY_DEFAULT, () => {});
    expect(entries.map((e) => (e.kind === 'item' ? [e.label, e.checked] : null))).toEqual(
      SHOWABLE_ORDER.map((el) => [ELEMENT_LABELS[el], ELEMENT_SHOWN_BY_DEFAULT[el]]),
    );
  });

  it('flips the chosen element', () => {
    const onToggle = vi.fn();
    const entries = dashboardMenuItems({ ...ELEMENT_SHOWN_BY_DEFAULT, system: false, panes: true }, onToggle);
    const run = (label: string): void => {
      const e = entries.find((x) => x.kind === 'item' && x.label === label);
      if (e?.kind === 'item') e.run();
    };
    run('System');
    run('Panes');
    expect(onToggle.mock.calls).toEqual([
      ['system', true],
      ['panes', false],
    ]);
  });
});
