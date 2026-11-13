// Working-directory capture from OSC 9;9 (ConEmu/Windows Terminal style, emitted by the
// bashrc PROMPT_COMMAND) and OSC 7 (file URLs). Paths come back in the running OS's form.

import type { AwsContext } from './cloudContextModel';
import type { Os } from './platform';

const FILE_PREFIX = 'file://';

/**
 * xterm.js hands an OSC 9 handler everything after `ESC ] 9;`, so the shell's
 * `ESC ] 9;9;C:\path` arrives as `9;C:\path`. Only the `9` subcommand carries a path;
 * other subcommands (e.g. `4;...` progress) return null.
 */
export function parseOsc9(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0 || data.slice(0, sep) !== '9') return null;

  let path = data.slice(sep + 1);
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  // Any program's output can send this, and the folder is probed on disk as soon as it lands,
  // so a UNC path (`\\host\share`) would make Windows authenticate to that host over SMB.
  return DRIVE_PATH.test(path) ? path : null;
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Parses a `file://host/path` URL into a path for `os`; the host is ignored. On Windows only
 * drive-letter paths map, and anything else (`/home/...`, `/tmp`) returns null. Elsewhere the
 * path is taken as it is, with doubled and trailing slashes dropped.
 */
export function parseOsc7(data: string, os: Os = 'windows'): string | null {
  if (!data.startsWith(FILE_PREFIX)) return null;

  const rest = data.slice(FILE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest.slice(slash));
  } catch {
    return null;
  }

  if (os !== 'windows') {
    if (!decoded.startsWith('/') || decoded.includes('\0')) return null;
    return `/${decoded.split('/').filter((s) => s !== '').join('/')}`;
  }

  // Git Bash reports `/c/...`; some emitters report `/C:/...`. Both name a drive.
  let drive: string;
  let remainder: string;
  if (/^\/[A-Za-z]:/.test(decoded)) {
    drive = decoded[1];
    remainder = decoded.slice(3);
  } else if (/^\/[A-Za-z](\/|$)/.test(decoded)) {
    drive = decoded[1];
    remainder = decoded.slice(2);
  } else {
    return null;
  }

  // Splitting on "/" and dropping empty segments makes trailing and doubled slashes
  // harmless, and keeps a drive root as `C:\`.
  const segments = remainder.split('/').filter((s) => s !== '');
  if (segments.some((s) => s.includes('\\') || s.includes(':'))) return null;

  return `${drive.toUpperCase()}:\\${segments.join('\\')}`;
}

/**
 * Parses the private OSC 7502 cloud-context report. xterm.js hands the handler everything
 * after `ESC ] 7502;`, so `aws;prod;us-east-1` arrives whole. Either field may be empty. The
 * split stops after the second `;` so the region is taken verbatim; unknown providers return
 * null so a later provider can be added without older builds misreading it.
 */
export function parseOsc7502(data: string): AwsContext | null {
  const first = data.indexOf(';');
  if (first < 0 || data.slice(0, first) !== 'aws') return null;
  const second = data.indexOf(';', first + 1);
  if (second < 0) return { profile: data.slice(first + 1), region: '' };
  return { profile: data.slice(first + 1, second), region: data.slice(second + 1) };
}

export interface Osc133 {
  kind: 'A' | 'B' | 'C' | 'D';
  exitCode?: number;
}

/**
 * Parses an OSC 133 shell-integration marker. xterm.js hands the handler everything after
 * `ESC ] 133;`, so `D;0` arrives as `D;0`. A is prompt start, B is prompt end, C is command
 * output start, D is command finished (with an optional exit code). Unknown kinds return null.
 */
export function parseOsc133(data: string): Osc133 | null {
  const [kind, arg] = data.split(';');
  if (kind !== 'A' && kind !== 'B' && kind !== 'C' && kind !== 'D') return null;
  if (kind === 'D' && arg !== undefined && /^-?\d+$/.test(arg)) {
    return { kind, exitCode: Number(arg) };
  }
  return { kind };
}
