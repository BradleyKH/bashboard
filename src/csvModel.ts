/** CSV and TSV parsing for the Files preview's table (docs/design/files.md section 4.12). No DOM. */

export interface CsvTable {
  /** Every row padded to `columns` cells. The first row is the header. */
  rows: string[][];
  columns: number;
  /** Rows in the file, which is more than `rows.length` when the parse stopped at the cap. */
  totalRows: number;
}

/** Rows past this are counted but not kept; a table this long is unreadable in a preview anyway. */
export const MAX_TABLE_ROWS = 5000;

export function delimiterFor(name: string): string {
  return name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
}

/**
 * RFC 4180 with the usual leniencies: CRLF, LF, or CR ends a row; a quoted field may hold the
 * delimiter, newlines, and doubled quotes; a quote inside an unquoted field is kept as text. A
 * trailing newline does not add an empty row, and a BOM is dropped.
 */
export function parseCsv(text: string, delimiter: string, maxRows = MAX_TABLE_ROWS): CsvTable {
  const rows: string[][] = [];
  let totalRows = 0;
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;

  const endRow = (): void => {
    row.push(field);
    field = '';
    totalRows++;
    if (rows.length < maxRows) rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += c;
    }
    i++;
  }
  if (field !== '' || row.length > 0 || quoted) endRow();

  const columns = rows.reduce((max, r) => Math.max(max, r.length), 0);
  for (const r of rows) while (r.length < columns) r.push('');
  return { rows, columns, totalRows };
}
