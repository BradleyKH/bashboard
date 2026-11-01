import { describe, expect, it } from 'vitest';
import { fontSuggestions, isSuggestionPick } from './fonts';
import { BUNDLED_FONT_FAMILY } from './fontsReady';

const f = (family: string, monospace = false) => ({ family, monospace });

describe('fontSuggestions', () => {
  it('leads with the bundled font and keeps the core order', () => {
    expect(fontSuggestions([f('Consolas', true), f('Arial')])).toEqual([BUNDLED_FONT_FAMILY, 'Consolas', 'Arial']);
  });

  it('drops a duplicate of the bundled font, exact or differently cased', () => {
    const found = [f(BUNDLED_FONT_FAMILY, true), f(BUNDLED_FONT_FAMILY.toUpperCase(), true), f('Consolas', true)];
    expect(fontSuggestions(found)).toEqual([BUNDLED_FONT_FAMILY, 'Consolas']);
  });

  it('gives just the bundled font for an empty list', () => {
    expect(fontSuggestions([])).toEqual([BUNDLED_FONT_FAMILY]);
  });
});

describe('isSuggestionPick', () => {
  const options = ['Consolas', 'Arial'];

  it('accepts a replacement or an absent type with a listed value', () => {
    expect(isSuggestionPick('insertReplacementText', 'Consolas', options)).toBe(true);
    expect(isSuggestionPick(undefined, 'Arial', options)).toBe(true);
  });

  it('rejects typing, even a full listed name', () => {
    expect(isSuggestionPick('insertText', 'Consolas', options)).toBe(false);
  });

  it('rejects an unlisted value', () => {
    expect(isSuggestionPick('insertReplacementText', 'Nope', options)).toBe(false);
  });
});
