import { highlightTree, tags as t, type Tag } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';
import { loadLanguage, type LanguageId } from './languages';
import { ROLES, roleClass, roleHighlighter, type Role } from './roles';

/** The role of each token in `text`, keyed by the token's source text. */
async function rolesIn(id: LanguageId, text: string): Promise<Map<string, Role | 'none'>> {
  const { language } = await loadLanguage(id);
  const tree = language.parser.parse(text);
  const found = new Map<string, Role | 'none'>();
  highlightTree(tree, roleHighlighter, (from, to, cls) => {
    const role = ROLES.find((r) => cls === roleClass(r));
    found.set(text.slice(from, to), role ?? 'none');
  });
  return found;
}

function classOf(...tag: Tag[]): string | null {
  return roleHighlighter.style(tag);
}

describe('roleHighlighter', () => {
  it('names the eleven roles', () => {
    expect(ROLES).toHaveLength(11);
    expect(roleClass('keyword')).toBe('syn-keyword');
  });

  it('maps known tags to their role classes', () => {
    expect(classOf(t.keyword)).toBe('syn-keyword');
    expect(classOf(t.controlKeyword)).toBe('syn-keyword');
    expect(classOf(t.self)).toBe('syn-keyword');
    expect(classOf(t.string)).toBe('syn-string');
    expect(classOf(t.regexp)).toBe('syn-escape');
    expect(classOf(t.escape)).toBe('syn-escape');
    expect(classOf(t.number)).toBe('syn-constant');
    expect(classOf(t.bool)).toBe('syn-constant');
    expect(classOf(t.lineComment)).toBe('syn-comment');
    expect(classOf(t.docComment)).toBe('syn-comment');
    expect(classOf(t.function(t.variableName))).toBe('syn-function');
    expect(classOf(t.function(t.propertyName))).toBe('syn-function');
    expect(classOf(t.definition(t.function(t.variableName)))).toBe('syn-function');
    expect(classOf(t.className)).toBe('syn-type');
    expect(classOf(t.typeName)).toBe('syn-type');
    expect(classOf(t.propertyName)).toBe('syn-property');
    expect(classOf(t.tagName)).toBe('syn-tag');
    expect(classOf(t.attributeName)).toBe('syn-attribute');
    expect(classOf(t.meta)).toBe('syn-meta');
    expect(classOf(t.annotation)).toBe('syn-meta');
  });

  it('leaves identifiers, operators, and punctuation uncolored', () => {
    expect(classOf(t.variableName)).toBeNull();
    expect(classOf(t.operator)).toBeNull();
    expect(classOf(t.punctuation)).toBeNull();
    expect(classOf(t.bracket)).toBeNull();
  });

  it('colors a parsed TypeScript file by role', async () => {
    const roles = await rolesIn(
      'typescript',
      '// note\nconst n = 42;\nfunction greet(name: string) { return `hi ${name}`; }\ngreet("x");\n',
    );
    expect(roles.get('// note')).toBe('comment');
    expect(roles.get('const')).toBe('keyword');
    expect(roles.get('42')).toBe('constant');
    expect(roles.get('greet')).toBe('function');
    expect(roles.get('string')).toBe('type');
    expect(roles.get('"x"')).toBe('string');
  });

  it('colors template text as a string, keeping its escapes and interpolations', async () => {
    const roles = await rolesIn('typescript', 'const s = `hi\\n${count} items`;');
    expect(roles.get('`hi')).toBe('string');
    expect(roles.get('\\n')).toBe('escape');
    expect(roles.get(' items`')).toBe('string');
    expect(roles.has('count')).toBe(false);
  });

  it('colors a Python f-string and a Rust raw string as strings', async () => {
    const py = await rolesIn('python', 'x = f"a{b}c"\n');
    expect([...py.values()]).not.toContain('escape');
    expect(py.get('f"a')).toBe('string');
    const rs = await rolesIn('rust', 'let s = r"raw";\n');
    expect(rs.get('r"raw"')).toBe('string');
  });

  it('colors method names as functions and decorator names as meta in every JS dialect', async () => {
    const text = '@Component({ a: 1 }) class B { @ns.dec get size() { return 1; } total = 2; static load() {} }';
    for (const id of ['javascript', 'typescript', 'jsx', 'tsx'] as const) {
      const roles = await rolesIn(id, text);
      expect(roles.get('Component'), id).toBe('meta');
      expect(roles.get('ns'), id).toBe('meta');
      expect(roles.get('dec'), id).toBe('meta');
      expect(roles.get('size'), id).toBe('function');
      expect(roles.get('load'), id).toBe('function');
      expect(roles.get('total'), id).toBe('property');
      expect(roles.get('a'), id).toBe('property');
    }
  });

  it('colors JSX tags and attributes', async () => {
    const roles = await rolesIn('tsx', 'const a = <div className="x" />;');
    expect(roles.get('div')).toBe('tag');
    expect(roles.get('className')).toBe('attribute');
  });

  it('colors a legacy mode through the same highlighter', async () => {
    const roles = await rolesIn('csharp', '// c\nclass A { int n = 1; string s = "x"; }\n');
    expect(roles.get('// c')).toBe('comment');
    expect(roles.get('class')).toBe('keyword');
    expect(roles.get('1')).toBe('constant');
    expect(roles.get('"x"')).toBe('string');
  });
});
