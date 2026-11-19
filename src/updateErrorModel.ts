import type { Os } from './platform';

/** The release page a user downloads from when the app cannot update itself. */
export const LATEST_RELEASE_URL = 'https://github.com/BradleyKH/bashboard/releases/latest';

export type UpdatePhase = 'check' | 'install';

export interface UpdateErrorView {
  message: string;
  /** Offer a button that opens the latest release, for a manual download. */
  offerDownload: boolean;
}

/**
 * Turns an updater plugin error into a sentence for the banner or toast (docs/design/app.md
 * section 3.16). The plugin reports errors as their Rust Display text, so they are matched by
 * that text; anything unrecognized keeps its raw text.
 */
export function describeUpdateError(err: unknown, phase: UpdatePhase, os: Os): UpdateErrorView {
  const text = String(err);

  // latest.json lists one entry per platform and package type: Windows NSIS and the Linux .deb.
  // An AppImage, .rpm, or macOS build finds no entry of its own.
  if (/fallback platforms|platform `[^`]*` was not found/i.test(text)) {
    const message =
      os === 'linux'
        ? 'This install cannot update itself. Releases update the .deb package only; download the new version from the latest release.'
        : 'No update is published for this system. Download the new version from the latest release.';
    return { message, offerDownload: true };
  }

  if (phase === 'install') {
    // The plugin tries pkexec, then a zenity or kdialog password prompt, then a terminal sudo,
    // which fails without a terminal. Dismissing every prompt therefore usually ends in the
    // package error, not the cancelled one, so both read the same.
    if (/authentication failed or was cancelled|failed to install (\.deb )?package/i.test(text)) {
      return {
        message:
          'The update was not installed. If you cancelled the password prompt, try again; otherwise download the .deb from the latest release and install it with apt to see why.',
        offerDownload: true,
      };
    }
    if (/signature|minisign/i.test(text)) {
      return {
        message: 'The downloaded update failed its signature check, so it was not installed.',
        offerDownload: true,
      };
    }
  }

  if (/error sending request|dns error|timed out|connection (refused|reset)|network/i.test(text)) {
    return {
      message:
        phase === 'check'
          ? 'Could not reach GitHub to check for updates. Check your connection and try again.'
          : 'Could not download the update. Check your connection and try again.',
      offerDownload: false,
    };
  }

  return phase === 'check'
    ? { message: `Could not check for updates: ${text}`, offerDownload: false }
    : { message: `Update failed: ${text}`, offerDownload: true };
}
