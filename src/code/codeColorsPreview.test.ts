import { describe, expect, it } from 'vitest';
import { PREVIEW_SNIPPET } from './codeColorsPreview';
import { tokenize } from './highlightStatic';
import { ROLES } from './roles';

describe('PREVIEW_SNIPPET', () => {
  it('exercises every role', async () => {
    const lines = await tokenize(PREVIEW_SNIPPET, 'tsx');
    const seen = new Set(lines.flat().map((t) => t.cls));
    for (const role of ROLES) expect(seen.has(`syn-${role}`), role).toBe(true);
  });

  it('stays short enough for the Settings tab', () => {
    const count = PREVIEW_SNIPPET.split('\n').length;
    expect(count).toBeGreaterThanOrEqual(8);
    expect(count).toBeLessThanOrEqual(12);
  });
});
