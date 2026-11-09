import { renderLine, tokenize, type Token } from './highlightStatic';
import { languageIdForFence, type LanguageId } from './languages';

/** The language a rendered fence's `<code>` class names (markdown-it's `language-<info>`), or null. */
export function fenceLanguage(className: string): LanguageId | null {
  const m = /(?:^|\s)language-(\S+)/.exec(className);
  return m ? languageIdForFence(m[1]) : null;
}

/**
 * Colors every fenced block under `root` by its info string (docs/design/files.md section 4.22).
 * Each `<code>` becomes one span per line joined by "\n" text nodes, so its `textContent` stays
 * byte-identical and copy and find offsets are unchanged. Every block is tokenized before any is
 * rewritten, and nothing is written once `current()` turns false: the body may have been
 * re-rendered or switched to Plain while a parser loaded.
 */
export async function colorFences(root: HTMLElement, current: () => boolean): Promise<void> {
  const jobs: { code: Element; text: string; lines: Promise<Token[][] | null> }[] = [];
  for (const code of root.querySelectorAll('pre > code')) {
    const id = fenceLanguage(code.className);
    if (id === null) continue;
    const text = code.textContent ?? '';
    jobs.push({ code, text, lines: tokenize(text, id).catch(() => null) });
  }
  const done = await Promise.all(jobs.map((j) => j.lines));
  if (!current()) return;
  jobs.forEach(({ code, text }, i) => {
    const lines = done[i];
    // renderLine drops a CR, which would change the text; markdown-it normalizes them away anyway.
    if (lines === null || text.includes('\r')) return;
    const nodes: Node[] = [];
    text.split('\n').forEach((part, l) => {
      if (l > 0) nodes.push(document.createTextNode('\n'));
      const span = document.createElement('span');
      renderLine(span, part, lines[l] ?? []);
      nodes.push(span);
    });
    code.replaceChildren(...nodes);
  });
}

/** Undoes `colorFences`: each colored block back to one text node. */
export function stripFences(root: HTMLElement): void {
  for (const code of root.querySelectorAll('pre > code')) {
    if (code.childElementCount > 0) code.textContent = code.textContent ?? '';
  }
}
