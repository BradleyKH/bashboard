import { describe, expect, it } from 'vitest';
import { classifyLink, renderUnsanitized } from './markdownRender';

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
    expect(classifyLink('#top', file)).toEqual({ kind: 'anchor' });
    expect(classifyLink('guide.md#top', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\guide.md' });
  });

  it('resolves relative paths against the current file folder', () => {
    expect(classifyLink('other.md', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\other.md' });
    expect(classifyLink('./sub/a.md', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\sub\\a.md' });
    expect(classifyLink('../README.md', file)).toEqual({ kind: 'file', path: 'C:\\repo\\README.md' });
  });

  it('decodes percent escapes and strips query and fragment', () => {
    expect(classifyLink('my%20notes.md?x=1#h', file)).toEqual({ kind: 'file', path: 'C:\\repo\\docs\\my notes.md' });
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
