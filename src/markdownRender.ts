import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

/**
 * Markdown preview rendering (docs/design.md section 4.12, section 9). Raw HTML
 * is off, no image is ever requested, and the output is sanitized again
 * before it reaches the DOM.
 */

const md = new MarkdownIt({ html: false, linkify: true });

// A remote image would be a network request made by a file the user only
// opened to read, so images render as their alt text.
md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content);

/** markdown-it output before DOMPurify; exported so tests can run without a DOM. */
export function renderUnsanitized(text: string): string {
  return md.render(text);
}

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(renderUnsanitized(text), { FORBID_TAGS: ['img'] });
}

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'anchor' }
  | { kind: 'ignore' };

/**
 * Decides what a click on a rendered link does. Only http(s) leaves the app,
 * and only a relative path reaches another file; every other scheme, drive
 * path, or rooted path is ignored.
 */
export function classifyLink(href: string, currentFile: string): LinkTarget {
  const link = href.trim();
  if (link === '') return { kind: 'ignore' };
  if (link.startsWith('#')) return { kind: 'anchor' };
  if (/^https?:\/\//i.test(link)) return { kind: 'external', url: link };
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return { kind: 'ignore' };
  if (/^[\\/]/.test(link)) return { kind: 'ignore' };

  const rel = link.split('#')[0].split('?')[0];
  if (rel === '') return { kind: 'anchor' };
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
  return { kind: 'file', path: segments.join(sep) };
}
