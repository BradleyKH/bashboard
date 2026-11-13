import { describe, expect, it } from 'vitest';
import { cloudChips, compileProductionPattern, type AzureContext } from './cloudContextModel';

const pattern = compileProductionPattern('prod|prd|live');
const azure = (name: string, user: string | null = null): AzureContext => ({ name, id: 'sub-123', user });

describe('compileProductionPattern', () => {
  it('matches case-insensitively', () => {
    expect(compileProductionPattern('prod')?.test('CLIENT-PROD')).toBe(true);
  });

  it('returns null for an empty pattern', () => {
    expect(compileProductionPattern('')).toBeNull();
  });

  it('falls back to the default for an invalid pattern', () => {
    const re = compileProductionPattern('(unclosed');
    expect(re?.test('my-prd')).toBe(true);
    expect(re?.test('dev')).toBe(false);
  });

  it('is not stateful across repeated tests', () => {
    const re = compileProductionPattern('prod');
    expect([re?.test('prod'), re?.test('prod'), re?.test('prod')]).toEqual([true, true, true]);
  });
});

describe('cloudChips', () => {
  it('returns nothing when no context is set', () => {
    expect(cloudChips(null, null, pattern, true)).toEqual([]);
  });

  it('returns nothing for an AWS report with both fields empty', () => {
    expect(cloudChips({ profile: '', region: '' }, null, pattern, true)).toEqual([]);
  });

  it('shows a profile-only chip', () => {
    const [chip] = cloudChips({ profile: 'dev', region: '' }, null, pattern, true);
    expect(chip).toEqual({ provider: 'aws', text: 'aws dev', title: 'AWS\nProfile: dev', production: false });
  });

  it('shows a region-only chip with the profile as default', () => {
    const [chip] = cloudChips({ profile: '', region: 'eu-west-1' }, null, pattern, true);
    expect(chip.text).toBe('aws default · eu-west-1');
    expect(chip.title).toBe('AWS\nProfile: default\nRegion: eu-west-1');
    expect(chip.production).toBe(false);
  });

  it('joins profile and region', () => {
    const [chip] = cloudChips({ profile: 'dev', region: 'us-east-1' }, null, pattern, true);
    expect(chip.text).toBe('aws dev · us-east-1');
  });

  it('flags production when the profile matches', () => {
    const [chip] = cloudChips({ profile: 'acme-Prod', region: 'us-east-1' }, null, pattern, true);
    expect(chip.production).toBe(true);
  });

  it('does not match the region against the pattern', () => {
    const [chip] = cloudChips({ profile: 'dev', region: 'live-region' }, null, pattern, true);
    expect(chip.production).toBe(false);
  });

  it('hides Azure unless its name matches', () => {
    expect(cloudChips(null, azure('Dev Subscription'), pattern, true)).toEqual([]);
  });

  it('shows a matching Azure subscription as production with its details', () => {
    const [chip] = cloudChips(null, azure('Acme PROD', 'me@acme.test'), pattern, true);
    expect(chip).toEqual({
      provider: 'azure',
      text: 'az Acme PROD',
      title: 'Azure\nSubscription: Acme PROD\nSubscription id: sub-123\nUser: me@acme.test',
      production: true,
    });
  });

  it('omits the user line when unknown', () => {
    const [chip] = cloudChips(null, azure('prod-sub'), pattern, true);
    expect(chip.title).toBe('Azure\nSubscription: prod-sub\nSubscription id: sub-123');
  });

  it('lists AWS before Azure when both show', () => {
    const chips = cloudChips({ profile: 'dev', region: '' }, azure('live'), pattern, true);
    expect(chips.map((c) => c.provider)).toEqual(['aws', 'azure']);
  });

  it('returns nothing when disabled', () => {
    expect(cloudChips({ profile: 'prod', region: 'x' }, azure('prod'), pattern, false)).toEqual([]);
  });

  it('never marks production or shows Azure with a null pattern', () => {
    const chips = cloudChips({ profile: 'prod', region: '' }, azure('prod'), null, true);
    expect(chips).toHaveLength(1);
    expect(chips[0].production).toBe(false);
  });
});
