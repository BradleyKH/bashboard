import { describe, expect, it } from 'vitest';
import type { ColonyLike } from '../colonySync';
import { ColonyRelay } from './colonyRelay';

function recorder(): ColonyLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensure: (id, hue) => calls.push(`ensure ${id} ${hue}`),
    setMood: (id, mood) => calls.push(`mood ${id} ${mood}`),
    release: (id) => calls.push(`release ${id}`),
  };
}

describe('ColonyRelay', () => {
  it('is a no-op without a target', () => {
    const relay = new ColonyRelay();
    expect(() => {
      relay.ensure('a', 10);
      relay.setMood('a', 'busy');
      relay.release('a');
    }).not.toThrow();
  });

  it('forwards calls to an attached target', () => {
    const relay = new ColonyRelay();
    const target = recorder();
    relay.attach(target);
    relay.ensure('a', 10);
    relay.setMood('a', 'waiting');
    relay.release('a');
    expect(target.calls).toEqual(['ensure a 10', 'mood a waiting', 'release a']);
  });

  it('replays every live session with its latest mood on attach', () => {
    const relay = new ColonyRelay();
    relay.ensure('a', 10);
    relay.setMood('a', 'busy');
    relay.setMood('a', 'idle');
    relay.ensure('b', 200);
    const target = recorder();
    relay.attach(target);
    expect(target.calls).toEqual(['ensure a 10', 'mood a idle', 'ensure b 200']);
  });

  it('drops released sessions from the replay', () => {
    const relay = new ColonyRelay();
    relay.ensure('a', 10);
    relay.ensure('b', 20);
    relay.release('a');
    const target = recorder();
    relay.attach(target);
    expect(target.calls).toEqual(['ensure b 20']);
  });

  it('stops forwarding after detach', () => {
    const relay = new ColonyRelay();
    const target = recorder();
    relay.attach(target);
    relay.detach();
    relay.ensure('a', 10);
    expect(target.calls).toEqual([]);
  });
});
