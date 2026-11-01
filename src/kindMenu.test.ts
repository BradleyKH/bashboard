import { describe, expect, it, vi } from 'vitest';
import { kindMenuItems } from './kindMenu';
import type { PaneKind } from './paneKinds';

describe('kindMenuItems', () => {
  it('leaves out filtered kinds', () => {
    const items = kindMenuItems('terminal', vi.fn(), (k) => k !== 'containers' && k !== 'scratch');
    expect(items.map((i) => i.label)).toEqual(['Terminal', 'Files', 'Git', 'Search']);
  });

  it('always lists the current kind, checked', () => {
    const items = kindMenuItems('containers', vi.fn(), () => false);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Containers');
    expect(items[0].checked).toBe(true);
  });

  it('checks only the current kind and gives each an icon', () => {
    const items = kindMenuItems('git', vi.fn(), () => true);
    expect(items.filter((i) => i.checked).map((i) => i.label)).toEqual(['Git']);
    expect(items.every((i) => i.icon)).toBe(true);
  });

  it('does not call onChoose for the current kind', () => {
    const onChoose = vi.fn();
    const items = kindMenuItems('files', onChoose, () => true);
    items.find((i) => i.label === 'Files')!.run();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('calls onChoose with another kind', () => {
    const onChoose = vi.fn<(k: PaneKind) => void>();
    const items = kindMenuItems('files', onChoose, () => true);
    items.find((i) => i.label === 'Git')!.run();
    expect(onChoose).toHaveBeenCalledWith('git');
  });
});
