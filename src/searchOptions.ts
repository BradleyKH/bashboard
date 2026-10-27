// Code search options (docs/design.md section 7). Pure data, no DOM.

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated globs limiting which files are searched; empty searches all. */
  include: string;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: '',
};

/** Lenient: each field falls back to its default when missing or of the wrong type. */
export function parseSearchOptions(raw: unknown): SearchOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_SEARCH_OPTIONS };
  const r = raw as Record<string, unknown>;
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    caseSensitive: flag(r.caseSensitive, DEFAULT_SEARCH_OPTIONS.caseSensitive),
    wholeWord: flag(r.wholeWord, DEFAULT_SEARCH_OPTIONS.wholeWord),
    regex: flag(r.regex, DEFAULT_SEARCH_OPTIONS.regex),
    include: typeof r.include === 'string' ? r.include : DEFAULT_SEARCH_OPTIONS.include,
  };
}
