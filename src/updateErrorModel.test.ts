import { describe, expect, it } from 'vitest';
import { describeUpdateError } from './updateErrorModel';

describe('describeUpdateError', () => {
  const missing =
    'None of the fallback platforms `["linux-x86_64-appimage", "linux-x86_64"]` were found in the response `platforms` object';

  it('tells a Linux install with no manifest entry to download instead', () => {
    const view = describeUpdateError(missing, 'check', 'linux');
    expect(view.message).toMatch(/package manager it came from/);
    expect(view.offerDownload).toBe(true);
  });

  it('words a missing entry generally on other systems', () => {
    const view = describeUpdateError(missing, 'check', 'macos');
    expect(view.message).toMatch(/No update is published for this system/);
    expect(view.offerDownload).toBe(true);
  });

  it('gives a cancelled prompt and a failed package install the same advice', () => {
    for (const err of ['Authentication failed or was cancelled', 'Failed to install package', 'Failed to install .deb package']) {
      const view = describeUpdateError(err, 'install', 'linux');
      expect(view.message).toMatch(/cancelled the password prompt.*install it with your package manager/);
      expect(view.offerDownload).toBe(true);
    }
  });

  it('reports a bad signature without its raw text', () => {
    const view = describeUpdateError('Signature verification failed: minisign', 'install', 'linux');
    expect(view.message).toMatch(/signature check/);
  });

  it('separates a network failure while checking from one while downloading', () => {
    const err = 'error sending request for url (https://github.com/...)';
    expect(describeUpdateError(err, 'check', 'linux').message).toMatch(/to check for updates/);
    const install = describeUpdateError(err, 'install', 'windows');
    expect(install.message).toMatch(/Could not download the update/);
    expect(install.offerDownload).toBe(false);
  });

  it('keeps the raw text of an unknown error', () => {
    expect(describeUpdateError(new Error('boom'), 'check', 'windows')).toEqual({
      message: 'Could not check for updates: Error: boom',
      offerDownload: false,
    });
    expect(describeUpdateError('boom', 'install', 'windows').message).toBe('Update failed: boom');
  });
});
