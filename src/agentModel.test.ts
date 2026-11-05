import { describe, expect, it } from 'vitest';
import { agentLine, formatTokens, modelDisplayName } from './agentModel';

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

describe('agentLine', () => {
  const ctx = (model: string | null, contextTokens: number | null, contextWindow: number | null = null) => ({
    sessionId: 's',
    model,
    contextTokens,
    contextWindow,
  });

  it('joins the model name and token count', () => {
    expect(agentLine('claude', ctx('claude-opus-5-5', 112_400))).toBe('Opus 5.5 · 112k tokens');
  });

  it('shows whichever half is known', () => {
    expect(agentLine('claude', ctx(null, 1_200_000))).toBe('1.2M tokens');
    expect(agentLine('claude', ctx('claude-sonnet-5-5', null))).toBe('Sonnet 5.5');
  });

  it('is null without a context or with neither half', () => {
    expect(agentLine('claude', undefined)).toBeNull();
    expect(agentLine('claude', ctx(null, null))).toBeNull();
    expect(agentLine('codex', ctx(null, null))).toBeNull();
  });

  it('leads a Codex line with the agent name and shows the window when known', () => {
    expect(agentLine('codex', ctx('gpt-5.5', 112_400))).toBe('Codex · gpt-5.5 · 112k tokens');
    expect(agentLine('codex', ctx('gpt-5.5', 112_400, 272_000))).toBe('Codex · gpt-5.5 · 112k / 272k tokens');
  });

  it('shows only the model for Copilot', () => {
    expect(agentLine('copilot', ctx('gpt-5.5', null))).toBe('Copilot · gpt-5.5');
  });

  it('uses the window override only when the context has none', () => {
    expect(agentLine('codex', ctx('qwen3-coder:30b', 8000), 32_768)).toBe('Codex · qwen3-coder:30b · 8.0k / 32k tokens');
    expect(agentLine('codex', ctx('gpt-5.5', 8000, 272_000), 32_768)).toBe('Codex · gpt-5.5 · 8.0k / 272k tokens');
  });
});
