// Small 3D hit-test helpers on plain [x, y, z] arrays (unit tested).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = (t) => Math.max(0, Math.min(1, t));

export function distPointSeg(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 1e-12 ? clamp01(dot(sub(p, a), ab) / l2) : 0;
  return Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]);
}

// Closest distance between segments p1-q1 and p2-q2 (Ericson, Real-Time Collision Detection 5.1.9).
export function distSegSeg(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return Math.hypot(...r);
  if (a <= 1e-12) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  return Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
}

// A player's body from their head position: a head sphere and a torso capsule hanging below it.
export const HEAD_R = 0.13;
export const TORSO_R = 0.18;
export function body(head) {
  return {
    head,
    torsoTop: [head[0], head[1] - 0.3, head[2]],
    torsoBottom: [head[0], head[1] - 0.8, head[2]],
  };
}

// Which body part (if any) a segment (blade) touches.
export function segHitsBody(a, b, head) {
  const bd = body(head);
  if (distPointSeg(head, a, b) <= HEAD_R) return 'head';
  if (distSegSeg(a, b, bd.torsoTop, bd.torsoBottom) <= TORSO_R) return 'torso';
  return null;
}

// Which body part (if any) a sphere (ball, rock) of radius r at c touches.
export function sphereHitsBody(c, r, head) {
  const bd = body(head);
  if (Math.hypot(c[0] - head[0], c[1] - head[1], c[2] - head[2]) <= HEAD_R + r) return 'head';
  if (distPointSeg(c, bd.torsoTop, bd.torsoBottom) <= TORSO_R + r) return 'torso';
  return null;
}
