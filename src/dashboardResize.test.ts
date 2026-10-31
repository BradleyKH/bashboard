import { describe, expect, it } from 'vitest';
import { clampDashboardWidth, draggedWidth, MIN_DASHBOARD_WIDTH } from './dashboardResize';

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

describe('draggedWidth', () => {
  it('widens on a rightward move when docked left and narrows when docked right', () => {
    expect(draggedWidth(400, 500, 560, 'left', 1600)).toBe(460);
    expect(draggedWidth(400, 500, 560, 'right', 1600)).toBe(340);
  });

  it('narrows on a leftward move when docked left and widens when docked right', () => {
    expect(draggedWidth(400, 500, 440, 'left', 1600)).toBe(340);
    expect(draggedWidth(400, 500, 440, 'right', 1600)).toBe(460);
  });

  it('clamps to the minimum on either side', () => {
    expect(draggedWidth(400, 500, 0, 'left', 1600)).toBe(MIN_DASHBOARD_WIDTH);
    expect(draggedWidth(400, 500, 1500, 'right', 1600)).toBe(MIN_DASHBOARD_WIDTH);
  });

  it('clamps to 60% of the window on either side', () => {
    expect(draggedWidth(400, 500, 1500, 'left', 1000)).toBe(600);
    expect(draggedWidth(400, 500, 0, 'right', 1000)).toBe(600);
  });
});
