const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** Stable 0..1 hue from the session's name, or its cwd when unnamed (docs/design.md section 6.3). */
export function sessionHue(session: { name: string | null; cwd: string }): number {
  // Lowercase so the same folder typed with different drive-letter case keeps its hue.
  const key = session.name ? session.name : session.cwd.toLowerCase();
  let hash = FNV_OFFSET;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) / 2 ** 32;
}

/** CSS color for a hue swatch; matches hueColor in src/backdrop/render/palette.ts (HSL 0.9, 0.6). */
export function hueCss(hue: number): string {
  return `hsl(${Math.round(hue * 360)}deg 90% 60%)`;
}
