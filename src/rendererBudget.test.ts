import { describe, expect, it } from 'vitest';
import { RendererBudget } from './rendererBudget';

describe('RendererBudget', () => {
  it('grants slots up to the limit', () => {
    const budget = new RendererBudget(3);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.inUse).toBe(3);
  });

  it('refuses past the limit without counting the refused request', () => {
    const budget = new RendererBudget(2);
    budget.tryAcquire();
    budget.tryAcquire();
    expect(budget.tryAcquire()).toBe(false);
    expect(budget.inUse).toBe(2);
  });

  it('defaults to a limit of 8', () => {
    const budget = new RendererBudget();
    for (let i = 0; i < 8; i++) expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
  });

  it('release frees a slot', () => {
    const budget = new RendererBudget(1);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    budget.release();
    expect(budget.inUse).toBe(0);
    expect(budget.tryAcquire()).toBe(true);
  });

  it('release never drops below zero', () => {
    const budget = new RendererBudget(2);
    budget.release();
    budget.release();
    expect(budget.inUse).toBe(0);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.inUse).toBe(1);
  });
});
