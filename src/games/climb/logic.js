// Climbing Race layout. Pure (unit tested).
import { rng } from '../starship/logic.js';

export const TOP = 24; // bell height (m)
export const LEDGES = [6, 12, 18];
export const WALL_W = 1.8;
export const WALL_X = { host: -1.3, guest: 1.3 };
export const WALL_Z = -0.5; // front face of the wall
export const ROCK_SPEED = 6;
export const MAX_ROW_GAP = 0.5;

// Rows of holds from the floor to the bell. Both walls use the same seed, so the race is fair.
export function generateHolds(seed) {
  const r = rng(seed);
  const holds = [];
  let y = 0.55;
  while (y < TOP - 0.2) {
    const a = -0.7 + r() * 1.4;
    let b = -0.7 + r() * 1.4;
    if (Math.abs(a - b) < 0.35) b = a > 0 ? a - 0.45 - r() * 0.3 : a + 0.45 + r() * 0.3;
    holds.push([a, y], [Math.max(-0.8, Math.min(0.8, b)), y + (r() - 0.5) * 0.12]);
    if (r() < 0.25) holds.push([-0.75 + r() * 1.5, y + 0.2]);
    y += 0.36 + r() * (MAX_ROW_GAP - 0.36);
  }
  return holds;
}

// Highest floor (ground or ledge) at or below height y.
export function floorBelow(y) {
  let f = 0;
  for (const l of LEDGES) if (l <= y + 1e-6) f = l;
  return f;
}

export function rockY(age) {
  return TOP + 2 - ROCK_SPEED * age;
}
