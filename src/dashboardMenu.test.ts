import { describe, expect, it, vi } from 'vitest';
import { dashboardMenuItems } from './dashboardMenu';
import { ELEMENT_LABELS, ELEMENT_SHOWN_BY_DEFAULT, SECTION_GROUPS } from './dashboardSections';

describe('dashboardMenuItems', () => {
  it('lists every element and Pins under its group heading, checked when shown', () => {
    const entries = dashboardMenuItems(ELEMENT_SHOWN_BY_DEFAULT, () => {});
    expect(entries.map((e) => (e.kind === 'item' ? [e.label, e.checked] : e.kind === 'heading' ? e.label : null))).toEqual(
      SECTION_GROUPS.flatMap((g) => [
        g.title,
        ...g.sections.map((el) => [ELEMENT_LABELS[el], ELEMENT_SHOWN_BY_DEFAULT[el]]),
      ]),
    );
  });

  it('leaves out the Media toggle on macOS only', () => {
    const labels = (os: string): unknown[] => dashboardMenuItems(ELEMENT_SHOWN_BY_DEFAULT, () => {}, os).flatMap((e) => (e.kind === 'item' ? [e.label] : []));
    expect(labels('macos')).not.toContain('Media');
    expect(labels('windows')).toContain('Media');
    expect(labels('linux')).toContain('Media');
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
