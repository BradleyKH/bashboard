import { platformOs, type Os } from './platform';

/**
 * Whether file names on `os` compare without regard to case. Windows and macOS (APFS and HFS+ as
 * they ship) fold case; Linux file systems do not, so `Readme.md` and `README.md` are two files
 * there and folding would merge them.
 */
export function foldsCase(os: Os = platformOs()): boolean {
  return os !== 'linux';
}

/** A file or folder name as a comparison key: folded where the OS folds case. */
export function nameKey(name: string, os: Os = platformOs()): string {
  return foldsCase(os) ? name.toLowerCase() : name;
}

/**
 * `path` as a comparison key: `/` and `\` alike, repeated and trailing separators dropped, and case
 * folded where the OS folds it.
 */
export function pathKey(path: string, os: Os = platformOs()): string {
  return nameKey(path.replace(/[\\/]+/g, '/').replace(/\/+$/, ''), os);
}

/** Whether two paths name the same file or folder on `os`. */
export function samePath(a: string, b: string, os: Os = platformOs()): boolean {
  return pathKey(a, os) === pathKey(b, os);
}

/** `path` equals or sits inside `folder` on `os`. */
export function sameOrInside(path: string, folder: string, os: Os = platformOs()): boolean {
  const p = pathKey(path, os);
  const f = pathKey(folder, os);
  return p === f || p.startsWith(f + '/');
}
