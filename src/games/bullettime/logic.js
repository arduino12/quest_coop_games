// Bullet Time rules: time flows with your movement. Pure (unit tested).

export const MIN_SCALE = 0.05;
export const SHOT_BOOST = 0.18; // real seconds of full-speed time after any shot
export const AMMO = 6;
export const GUN_RESPAWN = 2.5; // game seconds after throwing your gun
export const PUNCH_SPEED = 2.5;
export const THROW_SPEED = 1.5;
export const PLAYER_BULLET_SPEED = 30;
export const ARENA_R = 7.5;
// Cover boxes: [x, z, halfX, halfZ, height].
export const COVER = [[-2.2, -3.2, 0.5, 0.3, 1.2], [2.0, -3.6, 0.4, 0.4, 1.6], [0, -5.2, 0.8, 0.3, 1.0]];

// How fast game time runs for a given amount of movement (meters per second of head + hands).
export function timeScale(motion) {
  return Math.max(MIN_SCALE, Math.min(1, MIN_SCALE + motion * 0.55));
}

export function motionOf(headSpeed, handSpeeds) {
  const hands = handSpeeds.length ? handSpeeds.reduce((a, b) => a + b, 0) / handSpeeds.length : 0;
  return headSpeed + 0.6 * hands;
}

export function levelConfig(n) {
  return {
    total: 3 + 2 * n,
    concurrent: Math.min(2 + Math.floor(n / 2), 6),
    walk: 1.1 + 0.1 * n,
    cooldown: Math.max(1.3, 3 - 0.2 * n),
    aimTime: Math.max(0.35, 0.8 - 0.05 * n),
    bulletSpeed: 8 + 0.5 * n,
    spread: Math.max(0.05, 0.25 - 0.02 * n),
  };
}

// Where an enemy wants to stand: on the line to its target, `range` meters away from it.
export function standoff(from, target, range) {
  const dx = from[0] - target[0], dz = from[2] - target[2];
  const d = Math.hypot(dx, dz) || 1;
  return [target[0] + (dx / d) * range, 0, target[2] + (dz / d) * range];
}

// Spawn points on a ring in front of the players (and all around from level 4).
export function spawnPoint(r, level) {
  const arc = level >= 4 ? Math.PI : Math.PI * 0.45; // +-81 degrees: always in front early on
  const a = (r() * 2 - 1) * arc;
  return [Math.sin(a) * ARENA_R, 0, -Math.cos(a) * ARENA_R];
}

export function insideCover(p, pad = 0) {
  return COVER.some(([x, z, hx, hz, h]) => Math.abs(p[0] - x) <= hx + pad && Math.abs(p[2] - z) <= hz + pad && p[1] <= h + pad);
}
