import { describe, it, expect } from 'vitest';
import { generateHolds, floorBelow, rockY, TOP, MAX_ROW_GAP } from '../src/games/climb/logic.js';

describe('climbing wall', () => {
  it('is the same for the same seed and different for another', () => {
    expect(generateHolds(7)).toEqual(generateHolds(7));
    expect(generateHolds(8)).not.toEqual(generateHolds(7));
  });

  it('always has a reachable next hold all the way to the bell', () => {
    for (let seed = 1; seed < 30; seed++) {
      const ys = [...new Set(generateHolds(seed).map(([, y]) => Math.round(y * 100) / 100))].sort((a, b) => a - b);
      expect(ys[0]).toBeLessThan(0.8);
      expect(ys[ys.length - 1]).toBeGreaterThan(TOP - 0.8);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeLessThanOrEqual(MAX_ROW_GAP + 0.13);
    }
  });

  it('keeps holds on the wall', () => {
    for (const [x] of generateHolds(3)) expect(Math.abs(x)).toBeLessThanOrEqual(0.8);
  });

  it('finds the floor you would land on', () => {
    expect(floorBelow(3)).toBe(0);
    expect(floorBelow(13.5)).toBe(12);
    expect(floorBelow(18)).toBe(18);
  });

  it('drops rocks from above the top', () => {
    expect(rockY(0)).toBeGreaterThan(TOP);
    expect(rockY(10)).toBeLessThan(0);
  });
});
