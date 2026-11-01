import { describe, expect, it, vi } from 'vitest';
import { openInItems, openInMenuItems, setOpenMenuGitProbe } from './openMenu';

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe('openInItems', () => {
  it('lists Git only for a git path, in order', () => {
    expect(labels(openInItems('C:/r', true, vi.fn()))).toEqual(['Terminal', 'Files', 'Git', 'Search', 'Editor']);
    expect(labels(openInItems('C:/r', false, vi.fn()))).toEqual(['Terminal', 'Files', 'Search', 'Editor']);
  });

  it('calls onOpenIn with the kind and path', () => {
    const onOpenIn = vi.fn();
    const items = openInItems('C:/r', true, onOpenIn);
    const kinds = ['terminal', 'files', 'git', 'search', 'editor'];
    items.forEach((it, i) => {
      it.run();
      expect(onOpenIn).toHaveBeenLastCalledWith(kinds[i], 'C:/r');
    });
  });
});

describe('openInMenuItems', () => {
  it('lists Git when the probe resolves true', async () => {
    setOpenMenuGitProbe(() => Promise.resolve(true));
    expect(labels(await openInMenuItems('C:/r', vi.fn()))).toContain('Git');
  });

  it('omits Git when the probe resolves false', async () => {
    setOpenMenuGitProbe(() => Promise.resolve(false));
    expect(labels(await openInMenuItems('C:/r', vi.fn()))).not.toContain('Git');
  });

  it('treats a rejecting probe as not git', async () => {
    setOpenMenuGitProbe(() => Promise.reject(new Error('boom')));
    expect(labels(await openInMenuItems('C:/r', vi.fn()))).toEqual(['Terminal', 'Files', 'Search', 'Editor']);
  });
});
