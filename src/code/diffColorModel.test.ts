import { describe, expect, it } from 'vitest';
import { diffLines } from '../gitModel';
import { buildDiffColorModel } from './diffColorModel';

const COMMIT = [
  'commit abc123',
  'Author: A <a@b.c>',
  '',
  '    Change two files',
  '',
  'diff --git a/src/one.ts b/src/one.ts',
  'index 111..222 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  'diff --git a/two.py b/two.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/two.py',
  '@@ -0,0 +1,2 @@',
  '+x = 1',
  '+y = 2',
  '',
].join('\n');

describe('buildDiffColorModel', () => {
  it('maps context, added, and removed rows of a two-file commit', () => {
    const m = buildDiffColorModel(COMMIT);
    expect(m.files.map((f) => f.path)).toEqual(['src/one.ts', 'two.py']);
    expect(m.files[0].newText).toBe('const a = 1;\nconst b = 3;\nconst c = 4;');
    expect(m.files[0].oldText).toBe('const a = 1;\nconst b = 2;\nconst c = 4;');
    expect(m.files[1].newText).toBe('x = 1\ny = 2');
    expect(m.files[1].oldText).toBe('');
    const rows = diffLines(COMMIT);
    expect(m.rows).toHaveLength(rows.length);
    const at = (text: string) => m.rows[rows.findIndex((r) => r.text === text)];
    expect(at(' const a = 1;')).toEqual({ file: 0, side: 'new', line: 0 });
    expect(at('-const b = 2;')).toEqual({ file: 0, side: 'old', line: 1 });
    expect(at('+const b = 3;')).toEqual({ file: 0, side: 'new', line: 1 });
    expect(at(' const c = 4;')).toEqual({ file: 0, side: 'new', line: 2 });
    expect(at('+x = 1')).toEqual({ file: 1, side: 'new', line: 0 });
    expect(at('+y = 2')).toEqual({ file: 1, side: 'new', line: 1 });
  });

  it('maps headers and hunk lines to none', () => {
    const m = buildDiffColorModel(COMMIT);
    diffLines(COMMIT).forEach((r, i) => {
      if (r.kind === 'meta' || r.kind === 'hunk') expect(m.rows[i]).toBeNull();
    });
  });

  it('does not read a removed "-- x" line as a header', () => {
    const text = ['diff --git a/q.sql b/q.sql', '--- a/q.sql', '+++ b/q.sql', '@@ -1 +1 @@', '--- old', '+++ new'].join('\n');
    const m = buildDiffColorModel(text);
    expect(m.files[0].path).toBe('q.sql');
    expect(m.files[0].oldText).toBe('-- old');
    expect(m.files[0].newText).toBe('++ new');
  });

  it('maps a No newline marker to none', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const m = buildDiffColorModel(text);
    expect(m.rows.slice(4)).toEqual([
      { file: 0, side: 'old', line: 0 },
      null,
      { file: 0, side: 'new', line: 0 },
      null,
    ]);
    expect(m.files[0].newText).toBe('new');
  });

  it('leaves a merge file uncolored', () => {
    const text = [
      'diff --cc f.ts',
      'index 1,2..3',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@@ -1,2 -1,2 +1,3 @@@',
      '  keep',
      '+ added',
      ' -gone',
      'diff --git a/g.ts b/g.ts',
      '--- a/g.ts',
      '+++ b/g.ts',
      '@@ -1 +1 @@',
      '+z',
    ].join('\n');
    const m = buildDiffColorModel(text);
    expect(m.files.map((f) => f.path)).toEqual(['g.ts']);
    expect(m.rows.slice(0, 8).every((r) => r === null)).toBe(true);
    expect(m.rows[12]).toEqual({ file: 0, side: 'new', line: 0 });
  });

  it('takes a path with spaces from the +++ line', () => {
    const text = [
      'diff --git a/my dir/b c.ts b/my dir/b c.ts',
      '--- a/my dir/b c.ts\t',
      '+++ b/my dir/b c.ts\t',
      '@@ -1 +1 @@',
      '+x',
    ].join('\n');
    expect(buildDiffColorModel(text).files[0].path).toBe('my dir/b c.ts');
  });

  it('takes a deleted file path from the --- line and a rename from rename to', () => {
    const del = [
      'diff --git a/old.rs b/old.rs',
      'deleted file mode 100644',
      '--- a/old.rs',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-fn x() {}',
    ].join('\n');
    const m = buildDiffColorModel(del);
    expect(m.files[0].path).toBe('old.rs');
    expect(m.rows[5]).toEqual({ file: 0, side: 'old', line: 0 });
    const ren = [
      'diff --git a/a b.ts b/c d.ts',
      'similarity index 100%',
      'rename from a b.ts',
      'rename to c d.ts',
    ].join('\n');
    expect(buildDiffColorModel(ren).files[0].path).toBe('c d.ts');
  });

  it('decodes a quoted path', () => {
    const q = '"b/caf\\303\\251.ts"';
    const text = [`diff --git "a/caf\\303\\251.ts" ${q}`, '--- "a/caf\\303\\251.ts"', `+++ ${q}`, '@@ -1 +1 @@', '+x'].join('\n');
    expect(buildDiffColorModel(text).files[0].path).toBe('café.ts');
  });

  it('uses the caller path for a diff with no diff --git header', () => {
    const text = ['@@ -1 +1,2 @@', ' a', '+b'].join('\n');
    const m = buildDiffColorModel(text, 'src/x.ts');
    expect(m.files).toEqual([{ path: 'src/x.ts', newText: 'a\nb', oldText: 'a' }]);
    expect(m.rows).toEqual([null, { file: 0, side: 'new', line: 0 }, { file: 0, side: 'new', line: 1 }]);
  });

  it('prefers the diff paths over the caller path, and handles CRLF and empty text', () => {
    const text = 'diff --git a/x.ts b/x.ts\r\n--- a/x.ts\r\n+++ b/x.ts\r\n@@ -1 +1 @@\r\n+one\r\n';
    const m = buildDiffColorModel(text, 'other.ts');
    expect(m.files[0].path).toBe('x.ts');
    expect(m.files[0].newText).toBe('one');
    expect(buildDiffColorModel('')).toEqual({ files: [], rows: [] });
  });
});
