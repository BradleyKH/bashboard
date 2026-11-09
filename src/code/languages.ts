/**
 * The language table behind code colors (docs/design/files.md section 4.22): file names and
 * fence info strings to a language id, and each id to its lazily loaded CodeMirror support. The
 * id table and both lookups are DOM-free; the loaders are referenced, never called, at import.
 */

import {
  LanguageDescription,
  LanguageSupport,
  type LRLanguage,
  StreamLanguage,
  type StreamParser,
  type StringStream,
} from '@codemirror/language';
import { styleTags, tags as t } from '@lezer/highlight';

export const LANGUAGE_IDS = [
  'html',
  'css',
  'scss',
  'sass',
  'less',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'json',
  'csharp',
  'python',
  'markdown',
  'yaml',
  'rust',
  'sql',
  'xml',
  'shell',
  'powershell',
  'toml',
  'dockerfile',
] as const;

export type LanguageId = (typeof LANGUAGE_IDS)[number];

/** Extensions (lowercase, no dot) per language. */
const EXTENSIONS: Record<LanguageId, readonly string[]> = {
  html: ['html', 'htm'],
  css: ['css'],
  scss: ['scss'],
  sass: ['sass'],
  less: ['less'],
  javascript: ['js', 'mjs', 'cjs'],
  typescript: ['ts', 'mts', 'cts'],
  jsx: ['jsx'],
  tsx: ['tsx'],
  json: ['json', 'jsonc', 'json5'],
  csharp: ['cs', 'csx'],
  python: ['py', 'pyi'],
  markdown: ['md', 'markdown'],
  yaml: ['yml', 'yaml'],
  rust: ['rs'],
  sql: ['sql'],
  xml: ['xml', 'csproj', 'props', 'targets', 'xaml', 'svg'],
  shell: ['sh', 'bash'],
  powershell: ['ps1', 'psm1', 'psd1'],
  toml: ['toml'],
  dockerfile: ['dockerfile'],
};

/** Names matched whole (lowercase), for files with no useful extension. */
const WHOLE_NAMES: Readonly<Record<string, LanguageId>> = {
  dockerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
};

/** Fence info-string aliases (lowercase); every extension above also works as an alias. */
const FENCE_ALIASES: Readonly<Record<string, LanguageId>> = {
  javascript: 'javascript',
  node: 'javascript',
  typescript: 'typescript',
  csharp: 'csharp',
  'c#': 'csharp',
  python: 'python',
  markdown: 'markdown',
  rust: 'rust',
  shell: 'shell',
  zsh: 'shell',
  powershell: 'powershell',
  pwsh: 'powershell',
  docker: 'dockerfile',
};

const BY_EXTENSION = new Map<string, LanguageId>();
for (const id of LANGUAGE_IDS) for (const ext of EXTENSIONS[id]) BY_EXTENSION.set(ext, id);

/** The language a file name colors as, or null when it has none. */
export function languageIdFor(fileName: string): LanguageId | null {
  const name = (fileName.split(/[\\/]/).pop() ?? '').toLowerCase();
  const whole = WHOLE_NAMES[name];
  if (whole) return whole;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (BY_EXTENSION.get(name.slice(dot + 1)) ?? null) : null;
}

/** The language a markdown fence's info string names, ignoring case and any text after the first word. */
export function languageIdForFence(info: string): LanguageId | null {
  const word = (info.trim().split(/\s+/)[0] ?? '').replace(/^[{.]+/, '').replace(/}$/, '').toLowerCase();
  if (word === '') return null;
  return FENCE_ALIASES[word] ?? BY_EXTENSION.get(word) ?? null;
}

/** Wraps a legacy line tokenizer, whose tokens reach the highlighter as standard tags. */
function legacy(parser: StreamParser<unknown>): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

/** A markdown fence's language, described once per id so each loads once. */
const fenceDescriptions = new Map<LanguageId, LanguageDescription>();

function fenceLanguage(info: string): LanguageDescription | null {
  const id = languageIdForFence(info);
  if (!id) return null;
  let description = fenceDescriptions.get(id);
  if (!description) {
    description = LanguageDescription.of({ name: id, load: () => loadLanguage(id) });
    fenceDescriptions.set(id, description);
  }
  return description;
}

/**
 * Load the fence languages a markdown document names, so a synchronous parse (the static path,
 * which cannot wait on a nested load) finds each fence's support already set.
 */
export async function loadFenceLanguages(markdown: string): Promise<void> {
  const loads: Promise<unknown>[] = [];
  const fence = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:`{3,}|~{3,})[ \t]*([^\s`]+)/gm;
  for (const m of markdown.matchAll(fence)) {
    const description = fenceLanguage(m[1]);
    if (description && !description.support) loads.push(description.load().catch(() => undefined));
  }
  await Promise.all(loads);
}

/**
 * lezer-javascript tags a class method's name as a plain property definition and a decorator's
 * name as a variable; section 4.22 colors the first as a function and the second as meta. Deeper
 * paths win over the grammar's own one-level rules.
 */
const jsRoleTags = styleTags({
  'MethodDeclaration/PropertyDefinition': t.function(t.definition(t.propertyName)),
  'Decorator/VariableName Decorator/MemberExpression/VariableName Decorator/MemberExpression/PropertyName': t.meta,
  'Decorator/CallExpression/VariableName Decorator/CallExpression/MemberExpression/VariableName': t.meta,
  'Decorator/CallExpression/MemberExpression/PropertyName': t.meta,
});

async function javascript(config: { jsx?: boolean; typescript?: boolean }): Promise<LanguageSupport> {
  const support = (await import('@codemirror/lang-javascript')).javascript(config);
  // LRLanguage.configure keeps the language's data facet, so its completions and the JSX
  // auto-close extension in `support.support` still apply to the reconfigured language.
  const language = (support.language as LRLanguage).configure({ props: [jsRoleTags] });
  return new LanguageSupport(language, support.support);
}

function words(list: string): Record<string, boolean> {
  return Object.fromEntries(list.split(' ').map((w) => [w, true]));
}

/** The rest of a C# verbatim string (`@"..."`), where `""` is an escaped quote. */
function verbatimString(stream: StringStream, state: { tokenize: unknown }): string {
  let next: string | void;
  while ((next = stream.next()) != null) {
    if (next === '"' && !stream.eat('"')) {
      state.tokenize = null;
      break;
    }
  }
  return 'string';
}

/**
 * The legacy `csharp` mode's own config, plus hooks that color preprocessor lines (`#region`) and
 * attributes as meta. An attribute is a `[` followed by a name (optionally `target:` first) where
 * only whitespace or earlier attributes precede it on the line, so `a[0]` and `x = [1, 2]` stay
 * plain. Only the bracket and the attribute name take meta; its arguments keep their own roles.
 */
async function csharp(): Promise<LanguageSupport> {
  const { clike } = await import('@codemirror/legacy-modes/mode/clike');
  type State = { tokenize: unknown };
  const before = (stream: StringStream) => stream.string.slice(0, stream.start);
  // A variable rather than an inline literal: clike's typings omit defKeywords and
  // typeFirstDefinitions, which the mode reads.
  const config = {
    name: 'csharp',
    keywords: words(
      'abstract as async await base break case catch checked class const continue' +
        ' default delegate do else enum event explicit extern finally fixed for' +
        ' foreach goto if implicit in init interface internal is lock namespace new' +
        ' operator out override params private protected public readonly record ref required return sealed' +
        ' sizeof stackalloc static struct switch this throw try typeof unchecked' +
        ' unsafe using virtual void volatile while add alias ascending descending dynamic from get' +
        ' global group into join let orderby partial remove select set value var yield',
    ),
    types: words(
      'Action Boolean Byte Char DateTime DateTimeOffset Decimal Double Func' +
        ' Guid Int16 Int32 Int64 Object SByte Single String Task TimeSpan UInt16 UInt32' +
        ' UInt64 bool byte char decimal double short int long object' +
        ' sbyte float string ushort uint ulong',
    ),
    blockKeywords: words('catch class do else finally for foreach if struct switch try while'),
    defKeywords: words('class interface namespace record struct var'),
    typeFirstDefinitions: true,
    atoms: words('true false null'),
    hooks: {
      '@': (stream: StringStream, state: State) => {
        if (stream.eat('"')) {
          state.tokenize = verbatimString;
          return verbatimString(stream, state);
        }
        stream.eatWhile(/[\w$_]/);
        return 'meta';
      },
      '#': (stream: StringStream) => {
        if (!/^\s*$/.test(before(stream))) return false;
        stream.skipToEnd();
        return 'meta';
      },
      '[': (stream: StringStream) => {
        if (!/^\s*(?:\[[^\]]*\]\s*)*$/.test(before(stream))) return false;
        return stream.match(/^\s*(?:\w+\s*:\s*)?[A-Za-z_][\w.]*/) ? 'meta' : false;
      },
    },
  };
  return legacy(clike(config));
}

const LOADERS: Record<LanguageId, () => Promise<LanguageSupport>> = {
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-sass')).sass(),
  sass: async () => (await import('@codemirror/lang-sass')).sass({ indented: true }),
  less: async () => (await import('@codemirror/lang-less')).less(),
  javascript: () => javascript({}),
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  csharp,
  python: async () => (await import('@codemirror/lang-python')).python(),
  markdown: async () => {
    const { markdown, markdownLanguage } = await import('@codemirror/lang-markdown');
    return markdown({ base: markdownLanguage, codeLanguages: fenceLanguage });
  },
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  shell: async () => legacy((await import('@codemirror/legacy-modes/mode/shell')).shell),
  powershell: async () => legacy((await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  toml: async () => legacy((await import('@codemirror/legacy-modes/mode/toml')).toml),
  dockerfile: async () => legacy((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile),
};

const loaded = new Map<LanguageId, Promise<LanguageSupport>>();

/** The language's CodeMirror support, loaded on first use and shared after; a failed load is retried. */
export function loadLanguage(id: LanguageId): Promise<LanguageSupport> {
  let support = loaded.get(id);
  if (!support) {
    support = LOADERS[id]();
    loaded.set(id, support);
    support.catch(() => loaded.delete(id));
  }
  return support;
}
