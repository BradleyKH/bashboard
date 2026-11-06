// Picks the Slideshow style's next image (docs/design.md section 6.5). Pure, so it is unit tested.

/**
 * In order, the image after the current one, wrapping. Shuffled, a random image not yet shown this
 * round, so every image appears once before any repeats, and never the current one twice in a row.
 * The folder is listed fresh before each pick, so files added or removed in between are honored.
 */
export class SlideshowOrder {
  private readonly shown = new Set<string>();

  constructor(private readonly random: () => number = Math.random) {}

  /** `files` is sorted; undefined only when it is empty. */
  next(files: string[], current: string | undefined, shuffle: boolean): string | undefined {
    if (files.length === 0) return undefined;
    if (!shuffle) {
      if (current === undefined) return files[0];
      // The first file sorting after the current one, so a deleted current file still advances.
      return files.find((f) => compare(f, current) > 0) ?? files[0];
    }
    let pool = files.filter((f) => f !== current && !this.shown.has(f));
    if (pool.length === 0) {
      this.shown.clear();
      pool = files.filter((f) => f !== current);
    }
    if (pool.length === 0) return files[0];
    const pick = pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))];
    this.shown.add(pick);
    return pick;
  }

  /** Forgets the round, for a changed folder. */
  reset(): void {
    this.shown.clear();
  }
}

/** Matches the core's case-insensitive sort of the listing. */
function compare(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
