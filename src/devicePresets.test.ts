import { describe, expect, it } from 'vitest';
import { DEVICE_PRESETS, fitScale, presetById, rotate } from './devicePresets';

const phone = presetById('phone');

describe('presetById', () => {
  it('finds a preset and falls back to Responsive', () => {
    expect(presetById('tablet').width).toBe(820);
    expect(presetById('nope').id).toBe('responsive');
    expect(presetById(null).id).toBe('responsive');
  });

  it('lists Responsive first with unique ids', () => {
    expect(DEVICE_PRESETS[0].width).toBeNull();
    expect(new Set(DEVICE_PRESETS.map((p) => p.id)).size).toBe(DEVICE_PRESETS.length);
  });
});

describe('rotate', () => {
  it('swaps width and height', () => {
    const r = rotate(phone);
    expect([r.width, r.height]).toEqual([844, 390]);
    expect(rotate(r)).toEqual(phone);
  });

  it('leaves Responsive alone', () => {
    const resp = presetById('responsive');
    expect(rotate(resp)).toBe(resp);
  });
});

describe('fitScale', () => {
  it('never scales up', () => {
    expect(fitScale(phone, { width: 2000, height: 2000 })).toBe(1);
  });

  it('shrinks to the tighter axis', () => {
    expect(fitScale(phone, { width: 390, height: 422 })).toBeCloseTo(0.5);
    expect(fitScale(phone, { width: 195, height: 844 })).toBeCloseTo(0.5);
  });

  it('is 1 for Responsive and unmeasured panes', () => {
    expect(fitScale(presetById('responsive'), { width: 10, height: 10 })).toBe(1);
    expect(fitScale(phone, { width: 0, height: 500 })).toBe(1);
  });
});
