import './syntax.css';
import { highlightTree } from '@lezer/highlight';
import { loadFenceLanguages, loadLanguage, type LanguageId } from './languages';
import { roleHighlighter } from './roles';

/** A colored span within one line: character offsets into that line, and its `syn-<role>` class. */
export interface Token {
  from: number;
  to: number;
  cls: string;
}

/**
 * Static highlighting for read-only code surfaces (docs/design/files.md section 4.22): one list of
 * spans per line, from the language's parser and the shared role highlighter. A span that crosses
 * a line break (a block comment, a template string) is cut at each break.
 */
export async function tokenize(text: string, languageId: LanguageId): Promise<Token[][]> {
  // CRLF and a lone CR both end a line, as in the editor, so offsets stay within one line.
  const src = text.replace(/\r\n?/g, '\n');
  const starts = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  const lines: Token[][] = starts.map(() => []);

  const { language } = await loadLanguage(languageId);
  if (languageId === 'markdown') await loadFenceLanguages(src);
  const tree = language.parser.parse(src);

  let line = 0;
  highlightTree(tree, roleHighlighter, (from, to, cls) => {
    // Spans arrive in document order, so the line cursor only moves forward.
    while (line + 1 < starts.length && starts[line + 1] <= from) line++;
    for (let l = line; l < starts.length && starts[l] < to; l++) {
      const lineEnd = l + 1 < starts.length ? starts[l + 1] - 1 : src.length;
      const a = Math.max(from, starts[l]);
      const b = Math.min(to, lineEnd);
      if (b > a) lines[l].push({ from: a - starts[l], to: b - starts[l], cls });
    }
  });
  return lines;
}

/**
 * Fills `el` with `text`, wrapping each token's characters in a `<span>` of its class. Built from
 * text nodes only, so file content is never parsed as HTML. A trailing CR is dropped.
 */
export function renderLine(el: HTMLElement, text: string, tokens: readonly Token[]): void {
  const line = text.endsWith('\r') ? text.slice(0, -1) : text;
  el.replaceChildren();
  let pos = 0;
  for (const tok of tokens) {
    const from = Math.max(tok.from, pos);
    const to = Math.min(tok.to, line.length);
    if (to <= from) continue;
    if (from > pos) el.append(document.createTextNode(line.slice(pos, from)));
    const span = document.createElement('span');
    span.className = tok.cls;
    span.textContent = line.slice(from, to);
    el.append(span);
    pos = to;
  }
  if (pos < line.length) el.append(document.createTextNode(line.slice(pos)));
}
