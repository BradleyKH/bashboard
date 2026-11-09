import { describe, expect, it } from 'vitest';
import { tokenize, type Token } from './highlightStatic';

function clsAt(line: Token[], text: string, word: string): string | undefined {
  const at = text.indexOf(word);
  return line.find((t) => t.from <= at && at < t.to)?.cls;
}

describe('tokenize', () => {
  it('colors keywords and strings in TypeScript', async () => {
    const text = "const greeting = 'hi';\n// note";
    const lines = await tokenize(text, 'typescript');
    expect(lines).toHaveLength(2);
    expect(clsAt(lines[0], text, 'const')).toBe('syn-keyword');
    expect(clsAt(lines[0], text, "'hi'")).toBe('syn-string');
    expect(lines[1].map((t) => t.cls)).toEqual(['syn-comment']);
    expect(lines[1][0]).toMatchObject({ from: 0, to: 7 });
  });

  it('tokenizes C# through the legacy mode', async () => {
    const text = 'public class Foo { string s = "x"; }';
    const [line] = await tokenize(text, 'csharp');
    expect(clsAt(line, text, 'public')).toBe('syn-keyword');
    expect(clsAt(line, text, '"x"')).toBe('syn-string');
  });

  it('colors a TypeScript method name as a function and a decorator name as meta', async () => {
    const src = ['class A {', '  @observer count = 1;', '  render() {}', '}'];
    const lines = await tokenize(src.join('\n'), 'typescript');
    expect(clsAt(lines[1], src[1], 'observer')).toBe('syn-meta');
    expect(clsAt(lines[1], src[1], 'count')).toBe('syn-property');
    expect(clsAt(lines[2], src[2], 'render')).toBe('syn-function');
  });

  it('colors C# attributes and preprocessor lines as meta, not indexing', async () => {
    const src = ['#region Setup', '[Obsolete("old")]', 'void F() {', '  var b = a[0];', '}', '#endregion'];
    const lines = await tokenize(src.join('\n'), 'csharp');
    expect(clsAt(lines[0], src[0], '#region')).toBe('syn-meta');
    expect(clsAt(lines[1], src[1], '[Obsolete')).toBe('syn-meta');
    expect(clsAt(lines[1], src[1], '"old"')).toBe('syn-string');
    expect(clsAt(lines[3], src[3], '[0]')).toBeUndefined();
    expect(clsAt(lines[5], src[5], '#endregion')).toBe('syn-meta');
  });

  it('colors a markdown fence by its language', async () => {
    const src = ['# T', '', '```ts', 'const x = 1;', '```', ''];
    const lines = await tokenize(src.join('\n'), 'markdown');
    expect(clsAt(lines[3], src[3], 'const')).toBe('syn-keyword');
  });

  it('cuts a multi-line span at each line break', async () => {
    const lines = await tokenize('/* a\nb */\nlet x', 'javascript');
    expect(lines[0]).toEqual([{ from: 0, to: 4, cls: 'syn-comment' }]);
    expect(lines[1]).toEqual([{ from: 0, to: 4, cls: 'syn-comment' }]);
    expect(lines[2][0]).toMatchObject({ from: 0, to: 3, cls: 'syn-keyword' });
  });

  it('treats CRLF as one line break', async () => {
    const lines = await tokenize('let a\r\nlet b\r\n', 'javascript');
    expect(lines).toHaveLength(3);
    expect(lines[1][0]).toMatchObject({ from: 0, to: 3 });
    expect(lines[2]).toEqual([]);
  });

  it('returns one empty line for empty text', async () => {
    expect(await tokenize('', 'json')).toEqual([[]]);
  });
});
