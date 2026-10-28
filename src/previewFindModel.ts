/** Past this many matches the preview stops highlighting more and the count reads "n+". */
export const MAX_FIND_MATCHES = 5000;

export interface FindMatches {
  /** Start and end offsets into the searched text, in order. */
  ranges: [number, number][];
  /** True when the search stopped at `limit`. */
  capped: boolean;
}

/** Case-insensitive, literal matches of `query` in `text`, without overlaps. */
export function findMatches(text: string, query: string, limit = MAX_FIND_MATCHES): FindMatches {
  const ranges: [number, number][] = [];
  if (query === '') return { ranges, capped: false };
  // A regex rather than toLowerCase(), which can change a string's length and shift offsets.
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (ranges.length === limit) return { ranges, capped: true };
    ranges.push([m.index, m.index + m[0].length]);
  }
  return { ranges, capped: false };
}

/** The first match starting at or after `offset`, wrapping to the first; -1 with no matches. */
export function matchAtOrAfter(ranges: readonly [number, number][], offset: number): number {
  if (ranges.length === 0) return -1;
  const i = ranges.findIndex(([start]) => start >= offset);
  return i < 0 ? 0 : i;
}

/** The next or previous match index, wrapping at either end. */
export function stepMatch(index: number, count: number, direction: 'next' | 'previous'): number {
  if (count === 0) return -1;
  if (index < 0) return direction === 'next' ? 0 : count - 1;
  return (index + (direction === 'next' ? 1 : count - 1)) % count;
}

/** The find bar's count text, matching the terminal find bar's wording. */
export function matchCountText(query: string, index: number, found: FindMatches): string {
  if (query === '') return '';
  const count = found.ranges.length;
  if (count === 0) return 'No results';
  if (found.capped) return `${count}+ matches`;
  return `${index + 1} of ${count}`;
}
