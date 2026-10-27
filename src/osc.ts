// Working-directory capture from OSC 9;9 (ConEmu/Windows Terminal style, emitted by the
// bashrc PROMPT_COMMAND) and OSC 7 (file URLs). Both return Windows paths.

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
  return path === '' ? null : path;
}

/**
 * Parses a `file://host/path` URL into a Windows path. The host is ignored. Only
 * drive-letter paths map to Windows; anything else (`/home/...`, `/tmp`) returns null.
 */
export function parseOsc7(data: string): string | null {
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
