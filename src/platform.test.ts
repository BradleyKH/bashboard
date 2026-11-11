import { describe, expect, it } from 'vitest';
import { primaryHeld, primaryName, primaryOnly, supports } from './platform';

describe('supports', () => {
  it('keeps every feature on Windows', () => {
    expect(supports('localBrowser', 'windows')).toBe(true);
    expect(supports('gitInstall', 'windows')).toBe(true);
  });

  it('hides the WebView2 and winget features on macOS', () => {
    expect(supports('localBrowser', 'macos')).toBe(false);
    expect(supports('gitInstall', 'macos')).toBe(false);
  });

  it('defaults to Windows before the core answers', () => {
    expect(supports('localBrowser')).toBe(true);
  });
});

describe('primary modifier', () => {
  const ctrl = { ctrlKey: true, metaKey: false };
  const cmd = { ctrlKey: false, metaKey: true };
  const both = { ctrlKey: true, metaKey: true };

  it('is Ctrl on Windows', () => {
    expect(primaryHeld(ctrl, 'windows')).toBe(true);
    expect(primaryHeld(cmd, 'windows')).toBe(false);
    expect(primaryOnly(both, 'windows')).toBe(false);
    expect(primaryName('windows')).toBe('Ctrl');
  });

  it('is Cmd on macOS, where Ctrl belongs to the shell', () => {
    expect(primaryHeld(cmd, 'macos')).toBe(true);
    expect(primaryHeld(ctrl, 'macos')).toBe(false);
    expect(primaryOnly(both, 'macos')).toBe(false);
    expect(primaryName('macos')).toBe('Cmd');
  });
});
