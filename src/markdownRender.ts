import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

/**
 * Markdown preview rendering (docs/design/files.md section 4.12, section 9). Raw HTML
 * is off, no image is ever requested, and the output is sanitized again
 * before it reaches the DOM.
 */

const md = new MarkdownIt({ html: false, linkify: true });

// A remote image would be a network request made by a file the user only
// opened to read, so images render as their alt text.
md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content);

// Headings carry their GitHub-style slug so a `#fragment` link can find them.
// It goes in a data attribute rather than an id: DOMPurify strips ids that
// clobber document properties, and several previews can share one page.
md.core.ruler.push('heading_anchors', (state) => {
  const seen = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const text = (tokens[i + 1].children ?? [])
      .filter((t) => t.type === 'text' || t.type === 'code_inline')
      .map((t) => t.content)
      .join('');
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    tokens[i].attrSet('data-anchor', count === 0 ? base : `${base}-${count}`);
  }
});

/** GitHub's heading slug: lowercase, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** markdown-it output before DOMPurify; exported so tests can run without a DOM. */
export function renderUnsanitized(text: string): string {
  return md.render(text);
}

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(renderUnsanitized(text), { FORBID_TAGS: ['img'] });
}

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; fragment?: string }
  | { kind: 'anchor'; fragment: string }
  | { kind: 'ignore' };

/**
 * Decides what a click on a rendered link does. Only http(s) leaves the app,
 * and only a relative path reaches another file; every other scheme, drive
 * path, or rooted path is ignored.
 */
export function classifyLink(href: string, currentFile: string): LinkTarget {
  const link = href.trim();
  if (link === '') return { kind: 'ignore' };
  if (link.startsWith('#')) return { kind: 'anchor', fragment: decodeFragment(link.slice(1)) };
  if (/^https?:\/\//i.test(link)) return { kind: 'external', url: link };
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return { kind: 'ignore' };
  if (/^[\\/]/.test(link)) return { kind: 'ignore' };

  const rel = link.split('#')[0].split('?')[0];
  const hash = link.indexOf('#');
  const fragment = hash < 0 ? '' : decodeFragment(link.slice(hash + 1));
  if (rel === '') return { kind: 'anchor', fragment };
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return { kind: 'ignore' };
  }

  const sep = currentFile.includes('\\') ? '\\' : '/';
  const segments = currentFile.split(/[\\/]/);
  segments.pop();
  for (const part of decoded.split(/[\\/]/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length <= 1) return { kind: 'ignore' };
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  const path = segments.join(sep);
  return fragment === '' ? { kind: 'file', path } : { kind: 'file', path, fragment };
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** Whether two absolute paths name the same file; Windows paths ignore case and slash direction. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  return norm(a) === norm(b);
}
