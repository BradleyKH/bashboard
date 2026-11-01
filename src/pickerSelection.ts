/** Index to select after the shown rows change under an open picker: the same value when it is still listed, else the old index clamped into range. */
export function selectionAfterRefresh(prevValue: string | undefined, prevIndex: number, shown: readonly string[]): number {
  if (shown.length === 0) return 0;
  if (prevValue !== undefined) {
    const at = shown.indexOf(prevValue);
    if (at >= 0) return at;
  }
  return Math.min(Math.max(prevIndex, 0), shown.length - 1);
}
