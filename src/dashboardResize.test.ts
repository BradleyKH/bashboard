import { describe, expect, it } from 'vitest';
import { clampDashboardWidth, MIN_DASHBOARD_WIDTH } from './dashboardResize';

describe('clampDashboardWidth', () => {
  it('keeps a width inside the range, rounded', () => {
    expect(clampDashboardWidth(400.6, 1600)).toBe(401);
  });

  it('never goes below the minimum', () => {
    expect(clampDashboardWidth(100, 1600)).toBe(MIN_DASHBOARD_WIDTH);
  });

  it('caps the width at 60% of the window', () => {
    expect(clampDashboardWidth(2000, 1000)).toBe(600);
  });

  it('keeps the minimum in a window too narrow for the cap', () => {
    expect(clampDashboardWidth(400, 300)).toBe(MIN_DASHBOARD_WIDTH);
  });
});
