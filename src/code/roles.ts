/** Token roles and the highlighter that maps Lezer tags to them (docs/design/files.md section 4.22). */

import { tagHighlighter, tags as t } from '@lezer/highlight';

/** The eleven roles a color scheme colors; everything else takes `--content-fg`. */
export const ROLES = [
  'keyword',
  'string',
  'escape',
  'constant',
  'comment',
  'function',
  'type',
  'property',
  'tag',
  'attribute',
  'meta',
] as const;

export type Role = (typeof ROLES)[number];

/** The class a role's tokens carry; the stylesheet colors it from `--syn-<role>`. */
export function roleClass(role: Role): string {
  return `syn-${role}`;
}

/**
 * Where a more specific tag (a function name) and its parent both map, the highlighter prefers
 * the more specific one, so `function(propertyName)` is a function and a bare `propertyName` is a
 * property. Legacy-mode tokens arrive as these same standard tags.
 *
 * `special(string)` stays with `string`: the shipped grammars use it for whole literals (template
 * strings, f-strings, raw strings, CDATA, heredocs), whose escapes carry their own `escape` tag.
 */
export const roleHighlighter = tagHighlighter([
  { tag: [t.keyword, t.self, t.modifier], class: roleClass('keyword') },
  { tag: [t.string, t.special(t.string), t.character], class: roleClass('string') },
  { tag: [t.escape, t.regexp], class: roleClass('escape') },
  { tag: [t.number, t.bool, t.null, t.atom], class: roleClass('constant') },
  { tag: t.comment, class: roleClass('comment') },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
      t.definition(t.function(t.propertyName)),
    ],
    class: roleClass('function'),
  },
  { tag: [t.typeName, t.className, t.namespace], class: roleClass('type') },
  { tag: t.propertyName, class: roleClass('property') },
  { tag: t.tagName, class: roleClass('tag') },
  { tag: t.attributeName, class: roleClass('attribute') },
  { tag: [t.meta, t.annotation, t.documentMeta, t.processingInstruction], class: roleClass('meta') },
]);
