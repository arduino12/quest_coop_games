// Fort Siege rules and helpers. Plain arrays only (unit tested).
//
// Two floating islands face each other along z. Each island has a local frame:
// x = right, y = up, z = away from the enemy (the player stands at +z, the fort is built at -z).

export const ISLAND = { dist: 14, half: 3 };
export const BUDGET = 40;
export const BUILD_TIME = 180;
export const BATTLE_TIME = 240;
export const RELOAD = 2.5;
export const MAX_PULL = 0.8;
export const MAX_SPEED = 26;
export const FALL_Y = -1.5;
export const GRAVITY = -9.81;

export const TYPE = { cube: 0, plank: 1, pillar: 2, crystal: 3, ball: 4 };
export const BLOCKS = {
  [TYPE.cube]: { size: [0.4, 0.4, 0.4], density: 1 },
  [TYPE.plank]: { size: [1.2, 0.2, 0.4], density: 1 },
  [TYPE.pillar]: { size: [0.25, 1.0, 0.25], density: 1 },
  [TYPE.crystal]: { size: [0.3, 0.6, 0.3], density: 0.6 },
  [TYPE.ball]: { radius: 0.22, density: 20 },
};

// Island-local layout.
export const PLAYER_LOCAL = [0, 0, 2.4];
export const CRYSTAL_LOCAL = [0, 0.32, -1.2];
export const SLING_LOCAL = [0.95, 0, 1.45];
export const POUCH_LOCAL = [0.95, 1.25, 1.35];
export const DISPENSERS = [
  { type: TYPE.cube, local: [-0.95, 1.0, 1.55] },
  { type: TYPE.plank, local: [-0.95, 1.0, 2.1] },
  { type: TYPE.pillar, local: [-0.95, 1.0, 2.65] },
];
export const BUILD_ZONE = { xMin: -2.8, xMax: 2.8, zMin: -2.8, zMax: 0.8 };

// Ids: crystals 1 (host) and 2 (guest); host blocks 1000+, guest blocks 2000+, cannonballs 5000+.
export const CRYSTAL_ID = { host: 1, guest: 2 };
export const ID_BASE = { host: 1000, guest: 2000 };
export const PROJECTILE_BASE = 5000;

export function ownerOfId(id) {
  if (id === 1 || (id >= 1000 && id < 2000)) return 'host';
  if (id === 2 || (id >= 2000 && id < 3000)) return 'guest';
  return 'neutral';
}

export const sideSign = (side) => (side === 'host' ? 1 : -1);

export function toWorldPos(side, [x, y, z]) {
  const s = sideSign(side);
  return [s * x, y, s * (ISLAND.dist + z)];
}

export function toLocalPos(side, [x, y, z]) {
  const s = sideSign(side);
  return [s * x, y, s * z - ISLAND.dist];
}

export const islandYaw = (side) => (side === 'host' ? 0 : Math.PI);

// Slingshot: pulling the pouch from `rest` to `hand` launches opposite to the pull.
export function launchVelocity(rest, hand) {
  const d = [rest[0] - hand[0], rest[1] - hand[1], rest[2] - hand[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 0.12) return null;
  const pull = Math.min(len, MAX_PULL);
  const k = (MAX_SPEED * (pull / MAX_PULL)) / len;
  return [d[0] * k, d[1] * k, d[2] * k];
}

export function trajectory(p0, v0, steps = 40, dt = 0.05, floorY = -6) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const p = [p0[0] + v0[0] * t, p0[1] + v0[1] * t + 0.5 * GRAVITY * t * t, p0[2] + v0[2] * t];
    pts.push(p);
    if (p[1] < floorY) break;
  }
  return pts;
}

// ---- quaternion helpers ([x, y, z, w]) ----
export function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function qAxis(axis, angle) {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

let cubeRots = null;
// The 24 rotations that map a box onto itself (axis-aligned orientations).
export function cubeRotations() {
  if (cubeRots) return cubeRots;
  const out = [];
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      for (let c = 0; c < 4; c++) {
        const q = qMul(qMul(qAxis([1, 0, 0], (a * Math.PI) / 2), qAxis([0, 1, 0], (b * Math.PI) / 2)), qAxis([0, 0, 1], (c * Math.PI) / 2));
        if (!out.some((o) => Math.abs(o[0] * q[0] + o[1] * q[1] + o[2] * q[2] + o[3] * q[3]) > 0.999)) out.push(q);
      }
    }
  }
  cubeRots = out;
  return out;
}

// Snaps a released block to the nearest axis-aligned orientation if it is within maxDeg.
export function nearestAxisQuat(q, maxDeg = 25) {
  let best = null;
  let bestDot = -1;
  for (const r of cubeRotations()) {
    const d = Math.abs(q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3]);
    if (d > bestDot) { bestDot = d; best = r; }
  }
  const angle = 2 * Math.acos(Math.min(1, bestDot));
  return angle <= (maxDeg * Math.PI) / 180 ? best.slice() : null;
}

// Distance from point p to an oriented box (center c, rotation q, half extents h).
export function distToBox(p, c, q, h) {
  // rotate (p - c) by the inverse of q
  const v = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const qi = [-q[0], -q[1], -q[2], q[3]];
  const t = qMul(qMul(qi, [v[0], v[1], v[2], 0]), q);
  const dx = Math.max(Math.abs(t[0]) - h[0], 0);
  const dy = Math.max(Math.abs(t[1]) - h[1], 0);
  const dz = Math.max(Math.abs(t[2]) - h[2], 0);
  return Math.hypot(dx, dy, dz);
}

// A simple fort for solo practice (island-local positions, resting on the floor).
export function premadeFort() {
  const list = [];
  const cube = BLOCKS[TYPE.cube].size[0];
  for (let row = 0; row < 3; row++) {
    for (let i = -2; i <= 2; i++) {
      list.push({ type: TYPE.cube, local: [i * cube, cube / 2 + row * cube, -0.3] });
    }
  }
  list.push({ type: TYPE.plank, local: [0, 3 * cube + 0.1, -0.3] });
  list.push({ type: TYPE.pillar, local: [-0.6, 0.5, -1.2] });
  list.push({ type: TYPE.pillar, local: [0.6, 0.5, -1.2] });
  return list;
}

// Who wins when battle time runs out: the side with more blocks still standing on its island.
export function timeoutWinner(counts) {
  if (counts.host === counts.guest) return 'draw';
  return counts.host > counts.guest ? 'host' : 'guest';
}

export function onIsland(side, worldPos) {
  const [x, y, z] = toLocalPos(side, worldPos);
  return y > -0.5 && Math.abs(x) <= ISLAND.half + 0.1 && Math.abs(z) <= ISLAND.half + 0.1;
}
