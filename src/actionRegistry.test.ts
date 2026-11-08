import { describe, expect, it } from 'vitest';
import { ACTION_REGISTRY, actionArg } from './actionRegistry';
import keysDoc from '../docs/design/keys.md?raw';
import userGuide from '../docs/user-guide.md?raw';
import defaultKeybindings from './defaultKeybindings.json';

const names = ACTION_REGISTRY.map((r) => r.name as string);

function backticked(text: string): Set<string> {
  return new Set([...text.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]));
}

describe('ACTION_REGISTRY', () => {
  it('names each action once', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('labels every action except sendInput', () => {
    for (const r of ACTION_REGISTRY) {
      if (r.name !== 'sendInput') expect('label' in r && r.label, r.name).toBeTruthy();
    }
  });

  it('knows every action in defaultKeybindings.json', () => {
    for (const e of defaultKeybindings) expect(names, e.action).toContain(e.action);
  });

  it('matches each default binding to its argument kind', () => {
    for (const e of defaultKeybindings as Record<string, unknown>[]) {
      const arg = actionArg(String(e.action));
      expect('direction' in e, `${e.keys}`).toBe(arg === 'direction');
      expect('index' in e, `${e.keys}`).toBe(arg === 'index');
      expect('input' in e, `${e.keys}`).toBe(arg === 'input');
    }
  });
});

describe('docs name every action', () => {
  it('lists every action in the section 4.5 defaults table or its no-default note', () => {
    const text = keysDoc;
    const start = text.indexOf('## 4.5');
    const end = text.indexOf('**Keybinding editor.**', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const named = backticked(text.slice(start, end));
    for (const name of names) expect(named.has(name), name).toBe(true);
  });

  it('uses only real action names where the user guide says "the `name` action"', () => {
    const cited = [...userGuide.matchAll(/the `([A-Za-z]+)`\s+action/g)].map((m) => m[1]);
    expect(cited.length).toBeGreaterThan(0);
    for (const name of cited) expect(names, name).toContain(name);
  });
});
