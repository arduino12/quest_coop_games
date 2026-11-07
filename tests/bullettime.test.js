import { describe, it, expect } from 'vitest';
import { timeScale, motionOf, levelConfig, standoff, spawnPoint, insideCover, MIN_SCALE, ARENA_R, COVER } from '../src/games/bullettime/logic.js';
import { rng } from '../src/games/starship/logic.js';

describe('time flows with movement', () => {
  it('almost stops when you stand still and runs at full speed when you move fast', () => {
    expect(timeScale(0)).toBe(MIN_SCALE);
    expect(timeScale(0.5)).toBeGreaterThan(0.3);
    expect(timeScale(5)).toBe(1);
  });
  it('counts head movement more than hand movement', () => {
    expect(motionOf(1, [0, 0])).toBeGreaterThan(motionOf(0, [1, 1]));
  });
});

describe('enemies', () => {
  it('stop at their standoff range on the line to the player', () => {
    const p = standoff([0, 0, -8], [0, 0, 0], 5);
    expect(p[2]).toBeCloseTo(-5);
  });
  it('spawn on the arena ring, in front early on', () => {
    const r = rng(3);
    for (let i = 0; i < 50; i++) {
      const p = spawnPoint(r, 1);
      expect(Math.hypot(p[0], p[2])).toBeCloseTo(ARENA_R);
      expect(p[2]).toBeLessThan(0.5);
    }
  });
  it('get more numerous, faster and more accurate', () => {
    const a = levelConfig(1), b = levelConfig(6);
    expect(b.total).toBeGreaterThan(a.total);
    expect(b.bulletSpeed).toBeGreaterThan(a.bulletSpeed);
    expect(b.spread).toBeLessThan(a.spread);
    expect(b.cooldown).toBeLessThan(a.cooldown);
  });
});

describe('cover', () => {
  it('blocks points inside a box but not above it', () => {
    const [x, z, , , h] = COVER[0];
    expect(insideCover([x, 0.5, z])).toBe(true);
    expect(insideCover([x, h + 0.5, z])).toBe(false);
    expect(insideCover([0, 1, 2])).toBe(false);
  });
});
