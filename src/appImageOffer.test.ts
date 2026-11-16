import { describe, expect, it, vi } from 'vitest';
import { offerAppImageEntry, type AppImageOfferDeps } from './appImageOffer';
import type { AppState } from './appState';

function setup(over: Partial<AppImageOfferDeps> & { shown?: boolean } = {}) {
  const state = { appImageOfferShown: over.shown ?? false } as AppState;
  const save = vi.fn();
  const toast = vi.fn();
  const install = vi.fn().mockResolvedValue(undefined);
  const deps: AppImageOfferDeps = {
    state,
    save,
    status: () => Promise.resolve(true),
    install,
    toast: toast as unknown as AppImageOfferDeps['toast'],
    ...over,
  };
  return { state, save, toast, install, run: () => offerAppImageEntry(deps) };
}

describe('offerAppImageEntry', () => {
  it('shows a toast with an Add button once, and remembers it was shown', async () => {
    const t = setup();
    await t.run();
    expect(t.toast).toHaveBeenCalledTimes(1);
    expect(t.toast.mock.calls[0][2].label).toBe('Add');
    expect(t.state.appImageOfferShown).toBe(true);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.install).not.toHaveBeenCalled();
  });

  it('does nothing once the offer was shown', async () => {
    const t = setup({ shown: true, status: () => Promise.reject(new Error('not asked')) });
    await t.run();
    expect(t.toast).not.toHaveBeenCalled();
  });

  it('does nothing, and keeps the flag clear, when there is nothing to offer', async () => {
    const t = setup({ status: () => Promise.resolve(false) });
    await t.run();
    expect(t.toast).not.toHaveBeenCalled();
    expect(t.state.appImageOfferShown).toBe(false);
    expect(t.save).not.toHaveBeenCalled();
  });

  it('treats an unreadable status as nothing to offer', async () => {
    const t = setup({ status: () => Promise.reject(new Error('no invoke')) });
    await t.run();
    expect(t.toast).not.toHaveBeenCalled();
    expect(t.state.appImageOfferShown).toBe(false);
  });

  it('installs when Add is pressed and reports the result', async () => {
    const t = setup();
    await t.run();
    await t.toast.mock.calls[0][2].run();
    expect(t.install).toHaveBeenCalledTimes(1);
    expect(t.toast).toHaveBeenLastCalledWith('Bashboard is in your applications menu.');
  });

  it('reports a failed install', async () => {
    const t = setup({ install: () => Promise.reject('disk full') });
    await t.run();
    await t.toast.mock.calls[0][2].run();
    expect(t.toast).toHaveBeenLastCalledWith('Could not add Bashboard to the menu: disk full');
  });
});
