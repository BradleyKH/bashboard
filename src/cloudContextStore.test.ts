import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AzureContext } from './cloudContextModel';

const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emit: null as null | ((e: { payload: unknown }) => void),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: api.listen }));

const { CloudContextStore } = await import('./cloudContextStore');

const prodSub: AzureContext = { name: 'Contoso Prod', id: 'sub-1', user: 'me@example.com' };
const settings = (badge: boolean, productionPattern: string) => ({ cloud: { badge, productionPattern } });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  api.invoke.mockReset();
  api.listen.mockReset();
  api.emit = null;
  api.listen.mockImplementation((_name: string, cb: (e: { payload: unknown }) => void) => {
    api.emit = cb;
    return Promise.resolve(() => {});
  });
});

describe('CloudContextStore', () => {
  it('shows the AWS chip with the default settings and no Azure', () => {
    const store = new CloudContextStore();
    expect(store.chipsFor({ profile: 'dev', region: 'us-east-1' }).map((c) => c.text)).toEqual(['aws dev · us-east-1']);
    expect(store.chipsFor(null)).toEqual([]);
  });

  it('takes the initial Azure context and later events, notifying on change only', async () => {
    api.invoke.mockResolvedValue(prodSub);
    const store = new CloudContextStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.start();
    await flush();
    expect(api.invoke).toHaveBeenCalledWith('azure_context');
    expect(store.chipsFor(null).map((c) => c.provider)).toEqual(['azure']);
    expect(cb).toHaveBeenCalledTimes(1);

    api.emit!({ payload: { ...prodSub } });
    expect(cb).toHaveBeenCalledTimes(1);
    api.emit!({ payload: null });
    expect(store.chipsFor(null)).toEqual([]);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('treats a failed invoke and listen as no Azure context', async () => {
    api.invoke.mockRejectedValue(new Error('no tauri'));
    api.listen.mockRejectedValue(new Error('no tauri'));
    const store = new CloudContextStore();
    store.start();
    await flush();
    expect(store.chipsFor(null)).toEqual([]);
  });

  it('applies settings, notifying only when they change', () => {
    const store = new CloudContextStore();
    const cb = vi.fn();
    store.subscribe(cb);
    store.applySettings(settings(true, 'prod|prd|live'));
    expect(cb).not.toHaveBeenCalled();
    store.applySettings(settings(true, '^dev$'));
    expect(store.chipsFor({ profile: 'dev', region: '' })[0].production).toBe(true);
    store.applySettings(settings(false, '^dev$'));
    expect(store.chipsFor({ profile: 'dev', region: '' })).toEqual([]);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
