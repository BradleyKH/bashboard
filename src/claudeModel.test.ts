import { describe, expect, it } from 'vitest';
import { claudeLine, formatTokens, modelDisplayName } from './claudeModel';

describe('formatTokens', () => {
  it('prints each tier at its boundaries', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(4321)).toBe('4.3k');
    expect(formatTokens(9999)).toBe('9.9k');
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(112_400)).toBe('112k');
    expect(formatTokens(999_999)).toBe('999k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });
});

describe('modelDisplayName', () => {
  it('names the family-first form with and without a minor, a date, or [1m]', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelDisplayName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5');
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(modelDisplayName('claude-opus-4-20250514[1m]')).toBe('Opus 4');
    expect(modelDisplayName('claude-sonnet-4')).toBe('Sonnet 4');
  });

  it('names the older version-first form', () => {
    expect(modelDisplayName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(modelDisplayName('claude-3-opus-20240229')).toBe('Opus 3');
    expect(modelDisplayName('claude-3-7-sonnet')).toBe('Sonnet 3.7');
  });

  it('shows unknown ids raw', () => {
    expect(modelDisplayName('gpt-x')).toBe('gpt-x');
    expect(modelDisplayName('<synthetic>')).toBe('<synthetic>');
    expect(modelDisplayName('claude-poet-5')).toBe('claude-poet-5');
    expect(modelDisplayName('')).toBe('');
  });
});

describe('claudeLine', () => {
  const ctx = (model: string | null, contextTokens: number | null) => ({ sessionId: 's', model, contextTokens });

  it('joins the model name and token count', () => {
    expect(claudeLine(ctx('claude-opus-5-5', 112_400))).toBe('Opus 5.5 · 112k tokens');
  });

  it('shows whichever half is known', () => {
    expect(claudeLine(ctx(null, 1_200_000))).toBe('1.2M tokens');
    expect(claudeLine(ctx('claude-sonnet-5-5', null))).toBe('Sonnet 5.5');
  });

  it('is null without a context or with neither half', () => {
    expect(claudeLine(undefined)).toBeNull();
    expect(claudeLine(ctx(null, null))).toBeNull();
  });
});
