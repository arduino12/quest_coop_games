import * as THREE from 'three';

// Shared visual building blocks for the neon look.

export function glowMat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
}

export function lineMat(color, opacity = 1) {
  return new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
}

export function starfield(count = 1500, rMin = 150, rMax = 400) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = rMin + Math.random() * (rMax - rMin);
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = r * s * Math.cos(th);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * s * Math.sin(th);
    c.setHSL(0.55 + Math.random() * 0.35, 0.6, 0.6 + Math.random() * 0.4);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

export function gridFloor(size = 20, divisions = 20, color = 0x3344aa, opacity = 0.5) {
  const grid = new THREE.GridHelper(size, divisions, color, color);
  grid.material.transparent = true;
  grid.material.opacity = opacity;
  return grid;
}

// Wireframe-ish outline of a box, for neon trims.
export function edges(geometry, color, opacity = 1) {
  return new THREE.LineSegments(new THREE.EdgesGeometry(geometry), lineMat(color, opacity));
}

export function rectLoop(w, h, color, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-w / 2, 0, 0), new THREE.Vector3(w / 2, 0, 0),
    new THREE.Vector3(w / 2, h, 0), new THREE.Vector3(-w / 2, h, 0),
  ]);
  return new THREE.LineLoop(g, lineMat(color, opacity));
}

// Pooled additive particles for sparks and explosions.
export class Particles {
  constructor(parent, { max = 600, size = 0.035 } = {}) {
    this.max = max;
    this.pos = new Float32Array(max * 3).fill(0);
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -1e4;
    this.col = new Float32Array(max * 3);
    this.col0 = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.cursor = 0;
    this.alive = 0;
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.col, 3);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('color', this.colAttr);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    parent.add(this.points);
    this._c = new THREE.Color();
  }

  burst(p, color, n = 20, speed = 2, life = 0.6, gravity = 0) {
    const c = this._c.set(color);
    const px = p.x ?? p[0], py = p.y ?? p[1], pz = p.z ?? p[2];
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const v = speed * (0.3 + 0.7 * Math.random());
      this.vel[i * 3] = v * s * Math.cos(th);
      this.vel[i * 3 + 1] = v * u;
      this.vel[i * 3 + 2] = v * s * Math.sin(th);
      this.pos[i * 3] = px; this.pos[i * 3 + 1] = py; this.pos[i * 3 + 2] = pz;
      this.col0[i * 3] = c.r; this.col0[i * 3 + 1] = c.g; this.col0[i * 3 + 2] = c.b;
      this.life0[i] = this.life[i] = life * (0.6 + 0.4 * Math.random());
      this.grav[i] = gravity;
    }
    this.alive = this.max;
  }

  update(dt) {
    if (!this.alive) return;
    let alive = 0;
    const drag = Math.max(0, 1 - 1.5 * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) {
        this.pos[j + 1] = -1e4;
        this.col[j] = this.col[j + 1] = this.col[j + 2] = 0;
        continue;
      }
      alive++;
      this.vel[j + 1] -= this.grav[i] * dt;
      this.vel[j] *= drag; this.vel[j + 1] *= drag; this.vel[j + 2] *= drag;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      const f = this.life[i] / this.life0[i];
      this.col[j] = this.col0[j] * f; this.col[j + 1] = this.col0[j + 1] * f; this.col[j + 2] = this.col0[j + 2] * f;
    }
    this.alive = alive;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }
}

export function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
