// Network smoothing helpers. Pure functions/classes (no three.js) so they can be unit tested.

export const r2 = (n) => Math.round(n * 100) / 100;
export const r3 = (n) => Math.round(n * 1000) / 1000;
export const r4 = (n) => Math.round(n * 10000) / 10000;

// Tracks offset = localClock - remoteClock (+ fastest one-way latency) from timestamped packets.
// The minimum seen is the best estimate; it relaxes upward slowly so clock drift or a
// route change can't leave it stuck too low.
export class ClockSync {
  constructor(relaxPerMs = 0.001) {
    this.offset = null;
    this.lastNow = 0;
    this.relax = relaxPerMs;
  }

  update(remoteT, now) {
    const est = now - remoteT;
    if (this.offset === null) this.offset = est;
    else this.offset = Math.min(est, this.offset + (now - this.lastNow) * this.relax);
    this.lastNow = now;
    return this.offset;
  }

  // The remote clock's "now" as seen from here.
  remoteNow(now) {
    return this.offset === null ? now : now - this.offset;
  }
}

function nlerpInto(out, i, a, b, t) {
  let bx = b[i], by = b[i + 1], bz = b[i + 2], bw = b[i + 3];
  if (a[i] * bx + a[i + 1] * by + a[i + 2] * bz + a[i + 3] * bw < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  const x = a[i] + (bx - a[i]) * t;
  const y = a[i + 1] + (by - a[i + 1]) * t;
  const z = a[i + 2] + (bz - a[i + 2]) * t;
  const w = a[i + 3] + (bw - a[i + 3]) * t;
  const l = Math.hypot(x, y, z, w) || 1;
  out[i] = x / l; out[i + 1] = y / l; out[i + 2] = z / l; out[i + 3] = w / l;
}

// Interpolates two flat arrays made of `stride`-sized records. Within each record a quaternion
// starting at `quatOffset` is nlerped; everything else is lerped. quatOffset < 0 means no quaternion.
export function interpolate(out, a, b, t, stride, quatOffset = -1) {
  const n = Math.min(a.length, b.length);
  for (let base = 0; base < n; base += stride) {
    for (let k = 0; k < stride && base + k < n; k++) {
      const i = base + k;
      if (k === quatOffset) {
        nlerpInto(out, i, a, b, t);
        k += 3;
        continue;
      }
      out[i] = a[i] + (b[i] - a[i]) * t;
    }
  }
  out.length = n;
  return out;
}

function copyInto(out, v) {
  for (let i = 0; i < v.length; i++) out[i] = v[i];
  out.length = v.length;
  return out;
}

// Ring of timestamped flat arrays (e.g. a player's head+hands pose).
export class SnapshotBuffer {
  constructor({ stride = 7, quatOffset = 3, max = 32 } = {}) {
    this.stride = stride;
    this.quatOffset = quatOffset;
    this.max = max;
    this.s = [];
  }

  get size() { return this.s.length; }
  get latest() { return this.s[this.s.length - 1]; }

  push(t, values) {
    const last = this.latest;
    if (last && t <= last.t) return false; // out-of-order packet on the unreliable channel
    this.s.push({ t, v: values });
    if (this.s.length > this.max) this.s.shift();
    return true;
  }

  sample(t, out = []) {
    const s = this.s;
    if (!s.length) return null;
    if (t <= s[0].t) return copyInto(out, s[0].v);
    const last = s[s.length - 1];
    if (t >= last.t) return copyInto(out, last.v);
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      if (t >= a.t) {
        const b = s[i];
        return interpolate(out, a.v, b.v, (t - a.t) / (b.t - a.t), this.stride, this.quatOffset);
      }
    }
    return copyInto(out, s[0].v);
  }

  clear() { this.s.length = 0; }
}

// Like SnapshotBuffer, but each snapshot is a list of entities: [[id, ...values], ...].
// sample() returns a Map id -> values for the entities present in the newer snapshot.
export class EntityBuffer {
  constructor({ quatOffset = -1, max = 20 } = {}) {
    this.quatOffset = quatOffset;
    this.max = max;
    this.s = [];
  }

  get size() { return this.s.length; }

  push(t, entries) {
    const last = this.s[this.s.length - 1];
    if (last && t <= last.t) return false;
    const map = new Map();
    for (const e of entries) map.set(e[0], e.slice(1));
    this.s.push({ t, map });
    if (this.s.length > this.max) this.s.shift();
    return true;
  }

  sample(t) {
    const s = this.s;
    if (!s.length) return null;
    let a = null;
    let b = null;
    if (t <= s[0].t) b = s[0];
    else if (t >= s[s.length - 1].t) b = s[s.length - 1];
    else {
      for (let i = s.length - 1; i > 0; i--) {
        if (t >= s[i - 1].t) { a = s[i - 1]; b = s[i]; break; }
      }
    }
    const out = new Map();
    const f = a ? (t - a.t) / (b.t - a.t) : 1;
    for (const [id, vb] of b.map) {
      const va = a && a.map.get(id);
      out.set(id, va ? interpolate([], va, vb, f, vb.length, this.quatOffset) : vb.slice());
    }
    return out;
  }

  clear() { this.s.length = 0; }
}
