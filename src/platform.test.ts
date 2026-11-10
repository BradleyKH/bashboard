import { describe, expect, it } from 'vitest';
import { supports } from './platform';

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
