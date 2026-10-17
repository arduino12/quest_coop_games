// Starship Bridge rules. Pure functions on plain arrays (unit tested).
//
// Coordinates are ship-relative along z: the ship always sits at z = 0 and the world streams
// toward +z at the current speed. x/y are absolute; the ship moves sideways within LAT bounds.

export const SHIP_R = 1.4;
export const LAT = { x: 14, y: 8 };
export const LAT_SPEED = 10;
export const ET = { asteroid: 0, enemy: 1, plasma: 2 };
export const SPAWN_Z = -230;
export const ENGAGE_Z = -55;
export const PLASMA_SPEED = 40;
export const SHIELD_REGEN = 8; // per second, after REGEN_DELAY without damage
export const REGEN_DELAY = 3;
export const BREACH_DRAIN = 0.8; // hull per second per open breach
export const MAX_BREACHES = 3;

// Cockpit-space spots where hull breaches can appear (within reach of the two stations).
export const BREACH_SPOTS = [
  [-1.55, 1.05, 0.1], [1.55, 1.05, 0.1],
  [-0.75, 1.0, 1.35], [0.75, 1.0, 1.35],
  [-1.35, 0.75, -0.65], [1.35, 0.75, -0.65],
  [0, 1.95, 0.6],
];

export function waveConfig(n) {
  return {
    asteroids: 10 + n * 6,
    enemies: n < 2 ? 0 : Math.min(1 + Math.floor((n - 1) * 0.9), 8),
    duration: 35 + n * 4,
    speed: 26 + n * 3,
    enemyFire: Math.max(1.6, 3.4 - n * 0.2),
  };
}

export const asteroidHp = (r) => (r < 1.4 ? 1 : r < 2.1 ? 3 : 5);

export function collisionDamage(type, r = 1) {
  if (type === ET.asteroid) return 10 + 8 * r;
  if (type === ET.plasma) return 12;
  return 30;
}

export function scoreFor(type, r = 1) {
  if (type === ET.asteroid) return r >= 2.1 ? 25 : 10;
  if (type === ET.enemy) return 100;
  return 5;
}

// Shield soaks damage first; returns the damage that reached the hull.
export function applyDamage(s, dmg) {
  const absorbed = Math.min(s.shield, dmg);
  s.shield -= absorbed;
  const rest = dmg - absorbed;
  s.hull = Math.max(0, s.hull - rest);
  return rest;
}

// Ray (origin o, unit direction d) vs sphere. Returns distance along the ray, or -1 for a miss.
export function raySphere(o, d, c, r) {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  if (-b - s >= 0) return -b - s;
  if (-b + s >= 0) return 0; // origin inside the sphere
  return -1;
}

export function hitsShip(p, r, ship) {
  return Math.hypot(p[0] - ship[0], p[1] - ship[1], p[2]) < r + SHIP_R;
}

export function clampShip(ship) {
  ship.x = Math.max(-LAT.x, Math.min(LAT.x, ship.x));
  ship.y = Math.max(-LAT.y, Math.min(LAT.y, ship.y));
  return ship;
}
