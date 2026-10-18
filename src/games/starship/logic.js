// Starship Bridge rules. Pure functions on plain arrays (unit tested).
//
// The ship flies freely through a spherical sector (yaw all the way round, pitch up to PITCH_MAX).
// Each level the crew must find and destroy every enemy outpost; outposts are guarded by turrets,
// mine fields and fighters. The static layout (outposts, turrets, mines, asteroids) is generated from
// a seed, so both players build the identical sector without sending it over the network.

export const SECTOR_R = 1400;
export const SHIP_R = 2.5;
export const YAW_RATE = 1.1; // rad/s at full stick
export const PITCH_RATE = 0.8;
export const PITCH_MAX = 1.1; // ~63 degrees
export const MIN_SPEED = 8;
export const MAX_SPEED = 55;
export const SHIELD_REGEN = 7; // per second, after REGEN_DELAY without damage
export const REGEN_DELAY = 3;
export const BREACH_DRAIN = 0.8; // hull per second per open breach
export const MAX_BREACHES = 3;
export const MINE_TRIGGER_R = 16;
export const MINE_BLAST_R = 22;
export const MINE_FUSE = 0.7;
export const SEEKER_RANGE = 170;
export const SEEKER_SPEED = 10;

export const ET = { outpost: 0, turret: 1, mine: 2, fighter: 3, plasma: 4 };
export const HIT_R = { [ET.outpost]: 12, [ET.turret]: 2.5, [ET.mine]: 2.4, [ET.fighter]: 3.2, [ET.plasma]: 1.2 };
export const BODY_R = { outpost: 17 }; // what the ship bumps into
export const SCORE = { [ET.outpost]: 500, [ET.turret]: 50, [ET.mine]: 10, [ET.fighter]: 100, [ET.plasma]: 5 };
export const DAMAGE = { plasma: 8, mine: 28, bump: 20 };

// Cockpit-space spots where hull breaches can appear (within reach of the two stations).
export const BREACH_SPOTS = [
  [-1.55, 1.05, 0.1], [1.55, 1.05, 0.1],
  [-0.75, 1.0, 1.35], [0.75, 1.0, 1.35],
  [-1.35, 0.75, -0.65], [1.35, 0.75, -0.65],
  [0, 1.95, 0.6],
];

// Level 1 is already a real fight; every level adds outposts, turrets, mines and fighters.
export function levelConfig(n) {
  return {
    outposts: Math.min(2 + Math.floor((n - 1) / 2), 5),
    turrets: Math.min(2 + Math.floor(n / 2), 6),
    coreHp: 30 + 8 * n,
    minesPerOutpost: 14 + 4 * n,
    fieldMines: 10 + 6 * n,
    seekerChance: Math.min(0.1 + 0.06 * n, 0.5),
    fighters: 2 + n,
    fighterCap: 3 + n,
    spawnEvery: Math.max(10, 26 - 2 * n),
    fighterSpeed: 32 + 2 * n,
    fighterHp: 3 + Math.floor(n / 3),
    fireEvery: Math.max(0.8, 2.0 - 0.12 * n),
    plasmaSpeed: 70 + 5 * n,
    spread: Math.max(1.5, 5 - 0.4 * n), // aim error in meters: lower = more accurate enemies
    asteroids: 40,
  };
}

// ---- seeded random ----
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- vectors ([x, y, z]) and quaternions ([x, y, z, w]) ----
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function randomUnit(r) {
  const u = r() * 2 - 1;
  const th = r() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return [s * Math.cos(th), u, s * Math.sin(th)];
}

// Orientation from yaw (around +y) then pitch (around the ship's x axis).
export function shipQuat(yaw, pitch) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}

export function forward(yaw, pitch) {
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

export function rotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

// Where to shoot so a projectile of speed `speed` meets a target moving at `vel`.
export function leadTarget(from, target, vel, speed) {
  const d = sub(target, from);
  const a = dot(vel, vel) - speed * speed;
  const b = 2 * dot(d, vel);
  const c = dot(d, d);
  let t;
  if (Math.abs(a) < 1e-6) t = b !== 0 ? -c / b : 0;
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return target.slice();
    const s = Math.sqrt(disc);
    const t1 = (-b - s) / (2 * a), t2 = (-b + s) / (2 * a);
    t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  }
  if (!(t > 0)) return target.slice();
  return add(target, scale(vel, t));
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

// Shield soaks damage first; returns the damage that reached the hull.
export function applyDamage(s, dmg) {
  const absorbed = Math.min(s.shield, dmg);
  s.shield -= absorbed;
  const rest = dmg - absorbed;
  s.hull = Math.max(0, s.hull - rest);
  return rest;
}

// Top-down tactical map, rotated so the ship's heading points "up" (toward -z on the table).
// Returns [mapX, mapZ, relativeHeight, clampedToEdge] with the map radius `radius` covering `range` meters.
export function mapProject(shipPos, shipYaw, p, range, radius) {
  const rel = sub(p, shipPos);
  const c = Math.cos(shipYaw), s = Math.sin(shipYaw);
  // rotate by -yaw around y
  let x = rel[0] * c - rel[2] * s;
  let z = rel[0] * s + rel[2] * c;
  const k = radius / range;
  x *= k;
  z *= k;
  const r = Math.hypot(x, z);
  const edge = r > radius;
  if (edge) { x *= radius / r; z *= radius / r; }
  return [x, z, rel[1] * k, edge];
}

// Builds the static part of a level. Identical on both players for the same (level, seed).
export function generateSector(level, seed) {
  const r = rng(seed);
  const cfg = levelConfig(level);
  const outposts = [];
  const turrets = [];
  const mines = [];
  const asteroids = [];
  const base = r() * Math.PI * 2;
  for (let i = 0; i < cfg.outposts; i++) {
    const ang = base + (i / cfg.outposts) * Math.PI * 2 + (r() - 0.5) * 0.8;
    const d = 550 + r() * 600;
    const p = [Math.sin(ang) * -d, (r() - 0.5) * 300, Math.cos(ang) * -d];
    const id = 100 + i;
    outposts.push({ id, type: ET.outpost, p, hp: cfg.coreHp });
    for (let k = 0; k < cfg.turrets; k++) {
      const a = (k / cfg.turrets) * Math.PI * 2;
      turrets.push({ id: 1000 + i * 10 + k, type: ET.turret, p: [p[0] + Math.cos(a) * 17, p[1] + (k % 2 ? 4 : -4), p[2] + Math.sin(a) * 17], hp: 4, owner: id });
    }
    for (let k = 0; k < cfg.minesPerOutpost; k++) {
      mines.push({ p: add(p, scale(randomUnit(r), 45 + r() * 60)), seeker: r() < cfg.seekerChance });
    }
  }
  // Mines scattered along the routes from the start point to each outpost.
  for (let k = 0; k < cfg.fieldMines; k++) {
    const o = outposts[k % outposts.length].p;
    const f = 0.2 + r() * 0.65;
    mines.push({ p: add(scale(o, f), scale(randomUnit(r), 20 + r() * 50)), seeker: r() < cfg.seekerChance });
  }
  mines.forEach((m, i) => { m.id = 3000 + i; m.type = ET.mine; m.hp = 1; });
  for (let k = 0; k < cfg.asteroids; k++) {
    const p = scale(randomUnit(r), 150 + r() * 1100);
    const rad = 6 + r() * 20;
    if (outposts.some((o) => dist(o.p, p) < 90 + rad)) continue;
    asteroids.push({ p, r: rad });
  }
  return { cfg, outposts, turrets, mines, asteroids };
}
