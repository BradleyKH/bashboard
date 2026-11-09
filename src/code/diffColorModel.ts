import { diffLines } from '../gitModel';

/** Where a diff row's code sits: a 0-based line of one side of one file. */
export interface DiffRowRef {
  /** Index into `DiffColorModel.files`. */
  file: number;
  side: 'new' | 'old';
  line: number;
}

export interface DiffColorFile {
  /** The file's path in the repo, or '' when the diff names none and the caller gave none. */
  path: string;
  /** Context and added lines of every hunk, prefix stripped, joined with LF. */
  newText: string;
  /** Context and removed lines of every hunk, prefix stripped, joined with LF. */
  oldText: string;
}

export interface DiffColorModel {
  files: DiffColorFile[];
  /**
   * One entry per row of `diffLines(text)`, same indices. Context and added rows point at the new
   * side, removed rows at the old side; headers, `@@` lines, `\ No newline` markers, and rows of
   * a merge (`diff --cc`) file are null.
   */
  rows: (DiffRowRef | null)[];
}

interface Headers {
  plus: string | null;
  minus: string | null;
  renameTo: string | null;
}

/** Decodes a C-quoted git path (`"a/caf\303\251"`); other paths pass through. */
function unquote(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...enc.encode(ch));
      continue;
    }
    const next = body[++i];
    const octal = /^[0-7]{3}/.exec(body.slice(i, i + 3));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else if (next === 'n') bytes.push(10);
    else if (next === 't') bytes.push(9);
    else bytes.push(...enc.encode(next ?? ''));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path in a `--- a/x` or `+++ b/x` line's value, or null for /dev/null. */
function headerPath(value: string): string | null {
  // Git ends a path that contains a space with a tab, so the path can be told from a timestamp.
  const path = unquote(value.replace(/\t.*$/, ''));
  if (path === '/dev/null') return null;
  return path.replace(/^[a-z]\//, '');
}

function resolvePath(h: Headers, fallback: string | undefined): string {
  return h.plus ?? h.minus ?? h.renameTo ?? fallback ?? '';
}

/**
 * Splits a unified diff or `git show` dump into files and maps each row of the diff view to the
 * line of a whole-file side it belongs to, so the view can tokenize each side once and color rows
 * from it (docs/design/files.md section 4.22). Rows match `diffLines` exactly.
 *
 * A file's path comes from its `+++` line, else `--- ` for a deletion, else `rename to`, because
 * the `diff --git a/x y b/x y` header is ambiguous when a path contains spaces. `fallbackPath`
 * names the file for a diff with no `diff --git` header, or whose headers name no path.
 */
export function buildDiffColorModel(text: string, fallbackPath?: string): DiffColorModel {
  const rows: (DiffRowRef | null)[] = [];
  const files: DiffColorFile[] = [];
  const sides: { oldLines: string[]; newLines: string[] }[] = [];
  const pending: Headers[] = [];

  let fileIdx = -1;
  let inHunk = false;
  let merge = false;
  let headers: Headers = { plus: null, minus: null, renameTo: null };

  const startFile = (): void => {
    files.push({ path: '', newText: '', oldText: '' });
    sides.push({ oldLines: [], newLines: [] });
    headers = { plus: null, minus: null, renameTo: null };
    pending.push(headers);
    fileIdx = files.length - 1;
  };

  if (fallbackPath !== undefined && !/^diff --(git|cc) /m.test(text)) startFile();

  for (const row of diffLines(text)) {
    const line = row.text;
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      inHunk = false;
      merge = line.startsWith('diff --cc ');
      if (merge) fileIdx = -1;
      else startFile();
      rows.push(null);
    } else if (row.kind === 'hunk') {
      // A headerless single-file diff starts its one file at the first hunk.
      if (fileIdx === -1 && !merge && files.length === 0) startFile();
      inHunk = true;
      rows.push(null);
    } else if (!inHunk) {
      if (fileIdx !== -1) {
        if (line.startsWith('+++ ')) headers.plus = headerPath(line.slice(4));
        else if (line.startsWith('--- ')) headers.minus = headerPath(line.slice(4));
        else if (line.startsWith('rename to ')) headers.renameTo = unquote(line.slice(10));
      }
      rows.push(null);
    } else if (fileIdx === -1 || line.startsWith('\\')) {
      rows.push(null);
    } else {
      const s = sides[fileIdx];
      const body = line.slice(1);
      if (row.kind === 'add') {
        rows.push({ file: fileIdx, side: 'new', line: s.newLines.length });
        s.newLines.push(body);
      } else if (row.kind === 'del') {
        rows.push({ file: fileIdx, side: 'old', line: s.oldLines.length });
        s.oldLines.push(body);
      } else {
        rows.push({ file: fileIdx, side: 'new', line: s.newLines.length });
        s.newLines.push(body);
        s.oldLines.push(body);
      }
    }
  }

  files.forEach((f, i) => {
    f.path = resolvePath(pending[i], fallbackPath);
    f.newText = sides[i].newLines.join('\n');
    f.oldText = sides[i].oldLines.join('\n');
  });
  return { files, rows };
}
