import { describe, expect, it } from 'vitest';
import { classifyLink, renderUnsanitized, samePath, slugify } from './markdownRender';

describe('heading anchors', () => {
  it('slugs headings the way GitHub does', () => {
    expect(slugify("A repo's view")).toBe('a-repos-view');
    expect(slugify('Codex, Copilot, and local AI models (preview)')).toBe('codex-copilot-and-local-ai-models-preview');
  });

  it('tags headings with their slug and numbers duplicates', () => {
    const out = renderUnsanitized('## The `bb` CLI\n\n## Pins\n\n## Pins');
    expect(out).toContain('<h2 data-anchor="the-bb-cli">');
    expect(out).toContain('<h2 data-anchor="pins">');
    expect(out).toContain('<h2 data-anchor="pins-1">');
  });
});

describe('renderUnsanitized', () => {
  it('escapes raw HTML', () => {
    const out = renderUnsanitized('<script>alert(1)</script>\n\n<b>hi</b>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('renders an image as its alt text with no img element', () => {
    const out = renderUnsanitized('![a <cat>](https://example.com/cat.png)');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('example.com/cat.png');
    expect(out).toContain('a &lt;cat&gt;');
  });

  it('keeps links and linkifies bare URLs', () => {
    expect(renderUnsanitized('[x](https://a.test/p)')).toContain('<a href="https://a.test/p">x</a>');
    expect(renderUnsanitized('see https://b.test now')).toContain('<a href="https://b.test">');
  });

  it('does not emit javascript: links', () => {
    expect(renderUnsanitized('[x](javascript:alert(1))')).not.toContain('<a href="javascript');
  });
});

describe('classifyLink', () => {
  const file = 'C:\\repo\\docs\\guide.md';

  it('treats http and https as external', () => {
    expect(classifyLink('https://a.test/x', file)).toEqual({ kind: 'external', url: 'https://a.test/x' });
    expect(classifyLink('HTTP://a.test', file)).toEqual({ kind: 'external', url: 'HTTP://a.test' });
  });

  it('treats fragments as anchors', () => {
    expect(classifyLink('#top', file)).toEqual({ kind: 'anchor', fragment: 'top' });
    expect(classifyLink('?x#a%20b', file)).toEqual({ kind: 'anchor', fragment: 'a b' });
    expect(classifyLink('guide.md#top', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\guide.md', fragment: 'top' });
    expect(classifyLink('guide.md', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\guide.md' });
  });

  it('compares Windows paths ignoring case and slash direction', () => {
    expect(samePath('C:\\Repo\\docs\\Guide.md', 'c:/repo/docs/guide.md')).toBe(true);
    expect(samePath('C:\\repo\\a.md', 'C:\\repo\\b.md')).toBe(false);
  });

  it('resolves relative paths against the current file folder', () => {
    expect(classifyLink('other.md', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\other.md' });
    expect(classifyLink('./sub/a.md', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\sub\\a.md' });
    expect(classifyLink('../README.md', file)).toEqual({ kind: 'file', path: 'C:\\repo\\README.md' });
  });

  it('decodes percent escapes, strips the query, and keeps the fragment apart', () => {
    expect(classifyLink('my%20notes.md?x=1#a%20b', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\my notes.md', fragment: 'a b' });
  });

  it('keeps forward slashes for a posix-style current file', () => {
    expect(classifyLink('b.md', '/home/u/a.md')).toEqual({ kind: 'file', path: '/home/u/b.md' });
  });

  it('ignores other schemes, rooted and drive paths, and escapes above the root', () => {
    for (const href of ['file:///C:/x', 'javascript:alert(1)', 'mailto:a@b.c', 'C:\\x.md', '/etc/passwd', '\\\\host\\s', '//host/x', '', '../../../x.md']) {
      expect(classifyLink(href, file)).toEqual({ kind: 'ignore' });
    }
  });

  it('ignores a malformed percent escape', () => {
    expect(classifyLink('%E0%A4%A.md', file)).toEqual({ kind: 'ignore' });
  });
});
