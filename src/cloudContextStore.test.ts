import { describe, expect, it, vi } from 'vitest';
import { CloudContextStore } from './cloudContextStore';

const settings = (badge: boolean, productionPattern: string) => ({ cloud: { badge, productionPattern } });

describe('CloudContextStore', () => {
  it('shows no chips with the default settings', () => {
    expect(new CloudContextStore().chipsFor({ profile: 'dev', region: 'us-east-1' })).toEqual([]);
  });

  it('shows the AWS chip once enabled', () => {
    const store = new CloudContextStore();
    store.applySettings(settings(true, 'prod|prd|live'));
    expect(store.chipsFor({ profile: 'dev', region: 'us-east-1' }).map((c) => c.text)).toEqual(['aws dev · us-east-1']);
    expect(store.chipsFor(null)).toEqual([]);
  });

  it('applies settings, notifying only when they change', () => {
    const store = new CloudContextStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.applySettings(settings(false, 'prod|prd|live'));
    expect(cb).not.toHaveBeenCalled();
    store.applySettings(settings(true, '^dev$'));
    expect(store.chipsFor({ profile: 'dev', region: '' })[0].production).toBe(true);
    store.applySettings(settings(false, '^dev$'));
    expect(store.chipsFor({ profile: 'dev', region: '' })).toEqual([]);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
