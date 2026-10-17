// Neon Handball rules and ball physics. Pure functions on plain arrays (unit tested).
//
// The tunnel runs along z. The host stands at +z, the guest at -z. Each player's goal is the
// wall behind them: a ball passing z > +halfL is a point for the guest, and vice versa.
// There is no gravity and walls bounce perfectly, so between hits the ball's path is fully
// deterministic and both players can simulate it identically.

export const T = { halfL: 7, halfW: 1.5, H: 2.6, ballR: 0.12, handR: 0.13 };
export const WIN_SCORE = 7;
export const MAX_SPEED = 14;
export const MIN_FORWARD = 0.6; // after a hit, at least this fraction of the speed goes toward the opponent

export const sideOf = (z) => (z >= 0 ? 'host' : 'guest');
export const otherSide = (side) => (side === 'host' ? 'guest' : 'host');
export const baseSpeed = (hits) => Math.min(4.5 + hits * 0.35, 12.5);
export const servePos = (side) => [0, 1.2, side === 'host' ? 5.0 : -5.0];

export function newBall(server) {
  return { p: servePos(server), v: [0, 0, 0], hits: 0, live: false, server };
}

export function cloneBall(b) {
  return { p: b.p.slice(), v: b.v.slice(), hits: b.hits, live: b.live, server: b.server };
}

// Advances the ball by dt. `practiceWall` makes the guest end a solid wall (solo mode).
// Returns { bounce, goal } where goal is the side whose back wall the ball passed.
export function stepBall(b, dt, practiceWall = false) {
  const ev = { bounce: false, goal: null };
  if (!b.live) return ev;
  const r = T.ballR;
  for (let k = 0; k < 3; k++) b.p[k] += b.v[k] * dt;
  // Mirror the overshoot back inside so the path is the same however the time is sliced.
  const reflect = (k, lo, hi) => {
    if (b.p[k] < lo) { b.p[k] = 2 * lo - b.p[k]; b.v[k] = Math.abs(b.v[k]); ev.bounce = true; }
    if (b.p[k] > hi) { b.p[k] = 2 * hi - b.p[k]; b.v[k] = -Math.abs(b.v[k]); ev.bounce = true; }
  };
  reflect(0, -T.halfW + r, T.halfW - r);
  reflect(1, r, T.H - r);
  if (b.p[2] > T.halfL) ev.goal = 'host';
  else if (b.p[2] < -T.halfL) {
    if (practiceWall) {
      b.p[2] = -2 * T.halfL - b.p[2];
      b.v[2] = Math.abs(b.v[2]);
      ev.bounce = true;
    } else ev.goal = 'guest';
  }
  return ev;
}

// Sphere-vs-sphere hit between a hand (position hp, velocity hv) and the ball.
// `side` is the hitter's side; the ball is steered so it always heads toward the opponent.
// Returns true and updates the ball if there was a hit.
export function paddleHit(b, hp, hv, side, hits = b.hits) {
  const R = T.ballR + T.handR;
  const dx = b.p[0] - hp[0], dy = b.p[1] - hp[1], dz = b.p[2] - hp[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist > R) return false;
  const dirZ = side === 'host' ? -1 : 1;
  const n = dist > 1e-6 ? [dx / dist, dy / dist, dz / dist] : [0, 0, dirZ];
  const rel = [b.v[0] - hv[0], b.v[1] - hv[1], b.v[2] - hv[2]];
  const vn = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
  if (vn >= 0) return false; // already separating

  const e = 0.85;
  const v = [b.v[0] - (1 + e) * vn * n[0], b.v[1] - (1 + e) * vn * n[1], b.v[2] - (1 + e) * vn * n[2]];
  const speed = Math.min(Math.max(Math.hypot(v[0], v[1], v[2]), baseSpeed(hits)), MAX_SPEED);
  let len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-6) { v[0] = 0; v[1] = 0; v[2] = dirZ; len = 1; }
  v[0] /= len; v[1] /= len; v[2] /= len;
  if (v[2] * dirZ < MIN_FORWARD) {
    const lat = Math.sqrt(1 - MIN_FORWARD * MIN_FORWARD);
    const l2 = Math.hypot(v[0], v[1]);
    v[2] = MIN_FORWARD * dirZ;
    if (l2 > 1e-6) { v[0] *= lat / l2; v[1] *= lat / l2; } else { v[0] = 0; v[1] = 0; v[2] = dirZ; }
  }
  b.v = [v[0] * speed, v[1] * speed, v[2] * speed];
  b.p = [hp[0] + n[0] * R, hp[1] + n[1] * R, hp[2] + n[2] * R];
  b.live = true;
  return true;
}
