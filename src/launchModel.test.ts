import { describe, expect, it } from 'vitest';
import { launchMenuItems, launchOptions, opensPane } from './launchModel';

describe('launchOptions', () => {
  it('lists every option in a git repo, editor last', () => {
    expect(launchOptions(true).map((o) => o.kind)).toEqual(['terminal', 'files', 'git', 'search', 'scratch', 'editor']);
  });

  it('drops Git outside a git repo', () => {
    expect(launchOptions(false).map((o) => o.kind)).not.toContain('git');
  });

  it('gives each option its own menu letter', () => {
    const keys = launchOptions(true).map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('launchMenuItems', () => {
  it('launches and previews the kind of the item, with its letter', () => {
    const launched: string[] = [];
    const previewed: string[] = [];
    const items = launchMenuItems(false, (k) => launched.push(k), (k) => previewed.push(k));
    const files = items.find((i) => i.label === 'Files')!;
    expect(files.key).toBe('f');
    files.onHighlight?.();
    files.run();
    expect(previewed).toEqual(['files']);
    expect(launched).toEqual(['files']);
  });
});

describe('opensPane', () => {
  it('is false only for the editor', () => {
    expect(launchOptions(true).filter((o) => !opensPane(o.kind)).map((o) => o.kind)).toEqual(['editor']);
  });
});
