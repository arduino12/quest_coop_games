import { describe, it, expect } from 'vitest';
import { applyDamage, raySphere, waveConfig, hitsShip, clampShip, LAT, SHIP_R } from '../src/games/starship/logic.js';

describe('damage', () => {
  it('drains the shield before the hull', () => {
    const s = { shield: 10, hull: 100 };
    expect(applyDamage(s, 25)).toBe(15);
    expect(s).toEqual({ shield: 0, hull: 85 });
  });

  it('never drops the hull below zero', () => {
    const s = { shield: 0, hull: 5 };
    applyDamage(s, 50);
    expect(s.hull).toBe(0);
  });
});

describe('raySphere', () => {
  it('finds the near intersection distance', () => {
    expect(raySphere([0, 0, 0], [0, 0, -1], [0, 0, -10], 1)).toBeCloseTo(9);
  });
  it('misses spheres off to the side or behind', () => {
    expect(raySphere([0, 0, 0], [0, 0, -1], [5, 0, -10], 1)).toBe(-1);
    expect(raySphere([0, 0, 0], [0, 0, -1], [0, 0, 10], 1)).toBe(-1);
  });
  it('returns 0 from inside', () => {
    expect(raySphere([0, 0, 0], [0, 0, -1], [0, 0, 0], 1)).toBe(0);
  });
});

describe('waves', () => {
  it('get harder', () => {
    const w1 = waveConfig(1), w5 = waveConfig(5);
    expect(w1.enemies).toBe(0);
    expect(w5.enemies).toBeGreaterThan(0);
    expect(w5.asteroids).toBeGreaterThan(w1.asteroids);
    expect(w5.speed).toBeGreaterThan(w1.speed);
  });
});

describe('ship', () => {
  it('collides by distance to the ship position', () => {
    expect(hitsShip([1, 0, 0], 0.5, [0, 0])).toBe(true);
    expect(hitsShip([SHIP_R + 2, 0, 0], 0.5, [0, 0])).toBe(false);
  });
  it('stays inside the flight corridor', () => {
    expect(clampShip({ x: 99, y: -99 })).toEqual({ x: LAT.x, y: -LAT.y });
  });
});
