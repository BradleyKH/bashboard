import { describe, expect, it } from 'vitest';
import { delimiterFor, parseCsv } from './csvModel';

describe('parseCsv', () => {
  it('splits rows and fields, padding short rows', () => {
    const t = parseCsv('a,b,c\n1,2\n', ',');
    expect(t.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
    ]);
    expect(t.columns).toBe(3);
    expect(t.totalRows).toBe(2);
  });

  it('handles quotes, embedded delimiters, newlines, and doubled quotes', () => {
    const t = parseCsv('name,note\r\n"Smith, J","said ""hi""\r\nthen left"\r\n', ',');
    expect(t.rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"\r\nthen left'],
    ]);
  });

  it('keeps a stray quote inside an unquoted field', () => {
    expect(parseCsv('5" pipe,x', ',').rows).toEqual([['5" pipe', 'x']]);
  });

  it('accepts CR line endings, drops a BOM, and keeps a last row without a newline', () => {
    expect(parseCsv('﻿a,b\r1,2', ',').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps empty trailing fields and empty lines as rows', () => {
    expect(parseCsv('a,\n\nb', ',').rows).toEqual([
      ['a', ''],
      ['', ''],
      ['b', ''],
    ]);
  });

  it('returns no rows for empty text', () => {
    expect(parseCsv('', ',')).toEqual({ rows: [], columns: 0, totalRows: 0 });
  });

  it('stops keeping rows at the cap but counts them all', () => {
    const t = parseCsv('h\n1\n2\n3\n', ',', 2);
    expect(t.rows).toEqual([['h'], ['1']]);
    expect(t.totalRows).toBe(4);
  });

  it('splits TSV on tabs', () => {
    expect(parseCsv('a\tb,c\n', delimiterFor('x.TSV')).rows).toEqual([['a', 'b,c']]);
    expect(delimiterFor('x.csv')).toBe(',');
  });
});
