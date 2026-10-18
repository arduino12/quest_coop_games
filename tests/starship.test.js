import { describe, it, expect } from 'vitest';
import {
  applyDamage, raySphere, levelConfig, generateSector, shipQuat, forward, rotate, leadTarget,
  mapProject, rng, dist, ET, add, scale,
} from '../src/games/starship/logic.js';

const close = (a, b, d = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));

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
});

describe('flight math', () => {
  it('forward matches the ship orientation for any yaw/pitch', () => {
    for (const [yaw, pitch] of [[0, 0], [Math.PI / 2, 0], [2.5, 0.7], [-1.2, -0.9], [Math.PI, 0.3]]) {
      close(rotate(shipQuat(yaw, pitch), [0, 0, -1]), forward(yaw, pitch));
    }
  });
  it('turning right (negative yaw) heads toward +x', () => {
    expect(forward(-Math.PI / 2, 0)[0]).toBeCloseTo(1);
  });
  it('positive pitch climbs', () => {
    expect(forward(0, 0.5)[1]).toBeGreaterThan(0);
  });
});

describe('leadTarget', () => {
  it('aims ahead of a moving target so the shot meets it', () => {
    const from = [0, 0, 0], target = [0, 0, -100], vel = [20, 0, 0], speed = 80;
    const aim = leadTarget(from, target, vel, speed);
    const t = dist(from, aim) / speed;
    close(add(target, scale(vel, t)), aim, 4);
    expect(aim[0]).toBeGreaterThan(0);
  });
  it('aims straight at a still target', () => {
    close(leadTarget([0, 0, 0], [10, 5, -50], [0, 0, 0], 60), [10, 5, -50]);
  });
});

describe('mapProject', () => {
  it('shows what is ahead at the top of the map whatever the heading', () => {
    for (const yaw of [0, 1, -2, 3]) {
      const ahead = add([0, 0, 0], scale(forward(yaw, 0), 300));
      const [x, z] = mapProject([0, 0, 0], yaw, ahead, 900, 0.2);
      expect(x).toBeCloseTo(0);
      expect(z).toBeLessThan(0);
    }
  });
  it('pins far objects to the rim', () => {
    const [x, z, , edge] = mapProject([0, 0, 0], 0, [0, 0, -5000], 900, 0.2);
    expect(edge).toBe(true);
    expect(Math.hypot(x, z)).toBeCloseTo(0.2);
  });
});

describe('levels', () => {
  it('start hard and keep getting harder', () => {
    const l1 = levelConfig(1), l6 = levelConfig(6);
    expect(l1.outposts).toBeGreaterThanOrEqual(2);
    expect(l1.fighters).toBeGreaterThanOrEqual(3);
    for (const k of ['outposts', 'turrets', 'coreHp', 'minesPerOutpost', 'fieldMines', 'fighters', 'plasmaSpeed']) {
      expect(l6[k]).toBeGreaterThanOrEqual(l1[k]);
    }
    expect(l6.fireEvery).toBeLessThan(l1.fireEvery);
  });

  it('generates the same sector from the same seed (both players agree)', () => {
    const a = generateSector(3, 1234), b = generateSector(3, 1234);
    expect(a).toEqual(b);
    expect(generateSector(3, 999).outposts[0].p).not.toEqual(a.outposts[0].p);
  });

  it('places outposts, turrets and mines with unique ids', () => {
    const s = generateSector(2, 42);
    const ids = [...s.outposts, ...s.turrets, ...s.mines].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(s.outposts.every((o) => o.type === ET.outpost)).toBe(true);
    expect(s.mines.length).toBe(s.cfg.outposts * s.cfg.minesPerOutpost + s.cfg.fieldMines);
    // outposts are a real trip away from the start
    expect(s.outposts.every((o) => dist(o.p, [0, 0, 0]) > 400)).toBe(true);
  });

  it('seeded random is repeatable', () => {
    const a = rng(7), b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
