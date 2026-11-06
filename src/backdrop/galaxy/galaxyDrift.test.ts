import { describe, expect, it } from 'vitest';
import { wanderAmplitude, wanderSpeed } from './galaxyDrift';

describe('color drift', () => {
  it('holds the hues still at 0', () => {
    expect(wanderAmplitude(0)).toBe(0);
    expect(wanderSpeed(0)).toBe(0);
  });

  it('wanders the full wheel at the slider top and grows with the rate', () => {
    expect(wanderAmplitude(4)).toBeCloseTo(0.5);
    expect(wanderAmplitude(0.2)).toBeGreaterThan(0.05);
    expect(wanderAmplitude(1)).toBeGreaterThan(wanderAmplitude(0.2));
    expect(wanderSpeed(4)).toBeGreaterThan(wanderSpeed(1));
  });

  it('treats a negative rate as 0', () => {
    expect(wanderAmplitude(-1)).toBe(0);
  });
});
