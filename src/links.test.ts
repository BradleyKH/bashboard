import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { isOpenableUrl, openLink } from './links';

function click(init: Partial<MouseEvent>): MouseEvent {
  return { ctrlKey: false, ...init } as unknown as MouseEvent;
}

describe('isOpenableUrl', () => {
  it.each([
    'http://example.com',
    'https://example.com/path?q=1#frag',
    'HTTPS://EXAMPLE.COM',
    'Http://example.com',
  ])('accepts %s', (url) => {
    expect(isOpenableUrl(url)).toBe(true);
  });

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ftp://example.com',
    'example',
    '',
  ])('rejects %s', (url) => {
    expect(isOpenableUrl(url)).toBe(false);
  });
});

describe('openLink', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it('invokes open_url when Ctrl is held on an openable URL', () => {
    openLink(click({ ctrlKey: true }), 'https://example.com');
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://example.com' });
  });

  it('does nothing without Ctrl', () => {
    openLink(click({ ctrlKey: false }), 'https://example.com');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does nothing for a non-http scheme even with Ctrl', () => {
    openLink(click({ ctrlKey: true }), 'file:///C:/x.txt');
    openLink(click({ ctrlKey: true }), 'javascript:alert(1)');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('logs a rejected invoke with console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValue(new Error('boom'));
    openLink(click({ ctrlKey: true }), 'https://example.com');
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('loopback routing', () => {
    it('routes Ctrl+click on a loopback URL to onOpenLocal', () => {
      const onOpenLocal = vi.fn();
      openLink(click({ ctrlKey: true }), 'http://127.0.0.1:5199/p1', { onOpenLocal });
      expect(onOpenLocal).toHaveBeenCalledWith('http://127.0.0.1:5199/p1');
      expect(invoke).not.toHaveBeenCalled();
    });

    it('sends Ctrl+Shift+click to the system browser', () => {
      const onOpenLocal = vi.fn();
      openLink(click({ ctrlKey: true, shiftKey: true }), 'http://localhost:3000', { onOpenLocal });
      expect(onOpenLocal).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledWith('open_url', { url: 'http://localhost:3000' });
    });

    it('keeps non-loopback links on the system browser', () => {
      const onOpenLocal = vi.fn();
      openLink(click({ ctrlKey: true }), 'https://example.com', { onOpenLocal });
      openLink(click({ ctrlKey: true }), 'http://app.localhost:3000', { onOpenLocal });
      expect(onOpenLocal).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('routes https loopback links to Local Browser', () => {
      const onOpenLocal = vi.fn();
      openLink(click({ ctrlKey: true }), 'https://localhost:7001/', { onOpenLocal });
      expect(onOpenLocal).toHaveBeenCalledWith('https://localhost:7001/');
    });

    it('falls back to the system browser without a handler', () => {
      openLink(click({ ctrlKey: true }), 'http://localhost:3000');
      expect(invoke).toHaveBeenCalledWith('open_url', { url: 'http://localhost:3000' });
    });

    it('does nothing without Ctrl', () => {
      const onOpenLocal = vi.fn();
      openLink(click({}), 'http://localhost:3000', { onOpenLocal });
      expect(onOpenLocal).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    });
  });
});
