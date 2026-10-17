import * as THREE from 'three';

const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

function makeCanvasMesh(w, h, res) {
  const canvas = document.createElement('canvas');
  canvas.width = res;
  canvas.height = Math.max(16, Math.round((res * h) / w));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  return { canvas, ctx: canvas.getContext('2d'), tex, mesh };
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A flat text label in 3D. set() only redraws when the text changes.
export class Label {
  constructor(text = '', { w = 1, h = 0.2, res = 512, color = '#ffffff', bg = null, size = 0.6, weight = '700' } = {}) {
    Object.assign(this, makeCanvasMesh(w, h, res));
    this.opts = { color, bg, size, weight };
    this.text = null;
    this.set(text);
  }

  set(text, color) {
    text = String(text);
    if (text === this.text && (!color || color === this.opts.color)) return;
    this.text = text;
    if (color) this.opts.color = color;
    this.draw();
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (this.opts.bg) {
      ctx.fillStyle = this.opts.bg;
      roundRect(ctx, 2, 2, W - 4, H - 4, Math.min(W, H) * 0.15);
      ctx.fill();
    }
    const lines = this.text.split('\n');
    let fs = (H * this.opts.size) / lines.length;
    ctx.font = `${this.opts.weight} ${fs}px ${FONT}`;
    const widest = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
    if (widest > W * 0.92) {
      fs *= (W * 0.92) / widest; // shrink to fit instead of squashing letters
      ctx.font = `${this.opts.weight} ${fs}px ${FONT}`;
    }
    ctx.fillStyle = this.opts.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = this.opts.color;
    ctx.shadowBlur = fs * 0.25;
    const lh = H / lines.length;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, lh * (i + 0.5), W * 0.96));
    this.tex.needsUpdate = true;
  }
}

// A clickable panel: title, wrapped text lines and a grid of buttons.
// Buttons: { label, onClick, enabled = true, accent }.
export class Panel {
  constructor({ w = 1.2, h = 0.8, res = 768, title = '', lines = [], buttons = [], cols = 1, accent = '#22e6ff' } = {}) {
    Object.assign(this, makeCanvasMesh(w, h, res));
    this.mesh.userData.panel = this;
    this.hoverIndex = -1;
    this.title = title;
    this.lines = lines;
    this.buttons = buttons;
    this.cols = cols;
    this.accent = accent;
    this.dirty = true;
    this.layout();
    this.draw();
  }

  // Cheap to call often: only redraws when something visible changed.
  set(opts) {
    const key = (k, v) => (k === 'buttons'
      ? JSON.stringify(v.map((b) => [b.label, b.enabled !== false, b.accent]))
      : JSON.stringify(v));
    let changed = false;
    for (const [k, v] of Object.entries(opts)) {
      if (key(k, this[k]) !== key(k, v)) changed = true;
      this[k] = v;
    }
    if ('buttons' in opts || changed) this.layout();
    if (changed) this.dirty = true;
  }

  layout() {
    const W = this.canvas.width, H = this.canvas.height;
    const n = this.buttons.length;
    if (!n) { this.buttonsTop = H; return; }
    const pad = W * 0.05, gap = W * 0.025;
    const bh = Math.min(H * 0.16, W * 0.1);
    const rows = Math.ceil(n / this.cols);
    const bw = (W - pad * 2 - gap * (this.cols - 1)) / this.cols;
    const top = H - pad - rows * bh - (rows - 1) * gap;
    this.buttonsTop = top;
    this.buttons.forEach((b, i) => {
      const r = Math.floor(i / this.cols), c = i % this.cols;
      b._r = { x: pad + c * (bw + gap), y: top + r * (bh + gap), w: bw, h: bh };
    });
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const pad = W * 0.05;
    ctx.clearRect(0, 0, W, H);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(6, 10, 26, 0.9)';
    roundRect(ctx, 4, 4, W - 8, H - 8, W * 0.03);
    ctx.fill();
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = W * 0.006;
    ctx.shadowColor = this.accent;
    ctx.shadowBlur = W * 0.015;
    ctx.stroke();
    ctx.shadowBlur = 0;

    let y = pad;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (this.title) {
      const fs = W * 0.062;
      ctx.font = `800 ${fs}px ${FONT}`;
      ctx.fillStyle = this.accent;
      ctx.fillText(this.title, pad, y, W - pad * 2);
      y += fs * 1.35;
    }
    const fs = W * 0.042;
    ctx.font = `500 ${fs}px ${FONT}`;
    ctx.fillStyle = '#dfe8ff';
    for (const line of this.lines) {
      for (const l of wrapLines(ctx, line, W - pad * 2)) {
        if (y + fs > this.buttonsTop - pad * 0.3) break;
        ctx.fillText(l, pad, y);
        y += fs * 1.3;
      }
    }

    this.buttons.forEach((b, i) => {
      const r = b._r;
      const enabled = b.enabled !== false;
      const accent = b.accent || this.accent;
      const hover = i === this.hoverIndex && enabled;
      ctx.globalAlpha = enabled ? 1 : 0.35;
      ctx.fillStyle = hover ? accent : 'rgba(255,255,255,0.06)';
      roundRect(ctx, r.x, r.y, r.w, r.h, r.h * 0.25);
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = W * 0.004;
      ctx.stroke();
      ctx.fillStyle = hover ? '#05060f' : '#ffffff';
      const bfs = Math.min(r.h * 0.45, W * 0.045);
      ctx.font = `700 ${bfs}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, r.x + r.w / 2, r.y + r.h / 2, r.w * 0.94);
      ctx.globalAlpha = 1;
    });
    this.tex.needsUpdate = true;
    this.dirty = false;
  }

  hitIndex(uv) {
    const x = uv.x * this.canvas.width;
    const y = (1 - uv.y) * this.canvas.height;
    return this.buttons.findIndex((b) => b._r && x >= b._r.x && x <= b._r.x + b._r.w && y >= b._r.y && y <= b._r.y + b._r.h);
  }

  setHover(i) {
    if (i !== this.hoverIndex) {
      this.hoverIndex = i;
      this.dirty = true;
    }
  }

  update() { if (this.dirty) this.draw(); }
}

function isShown(obj) {
  for (let o = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

// Laser-pointer interaction with panels, for every hand. Also handles mouse clicks on desktop.
export class UI {
  constructor(app) {
    this.app = app;
    this.panels = new Set();
    this.raycaster = new THREE.Raycaster();
    this.captured = new Set();
    this.lasers = app.hands.map((hand) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
      line.visible = false;
      hand.ray.add(line);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      dot.visible = false;
      app.scene.add(dot);
      return { line, dot };
    });

    const canvas = app.renderer.domElement;
    canvas.addEventListener('click', (e) => {
      if (app.renderer.xr.isPresenting || app.dragged) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, app.camera);
      const hit = this.raycaster.intersectObjects(this._meshes(), false)[0];
      if (hit) this._click(hit.object.userData.panel, hit.uv, null);
    });
  }

  add(panel) { this.panels.add(panel); return panel; }
  remove(panel) { this.panels.delete(panel); }
  clear() { this.panels.clear(); }

  // True if this hand is pointing at a panel (so games shouldn't treat its trigger as "fire").
  captures(hand) { return this.captured.has(hand); }

  _meshes() {
    return [...this.panels].filter((p) => isShown(p.mesh)).map((p) => p.mesh);
  }

  _click(panel, uv, hand) {
    const i = panel.hitIndex(uv);
    const b = panel.buttons[i];
    if (!b || b.enabled === false) return;
    this.app.sfx.click();
    hand?.pulse(0.3, 30);
    b.onClick?.();
  }

  update() {
    const meshes = this._meshes();
    const hovered = new Map();
    this.captured.clear();
    this.app.hands.forEach((hand, i) => {
      const { line, dot } = this.lasers[i];
      if (!hand.connected || !meshes.length) {
        line.visible = dot.visible = false;
        return;
      }
      this.raycaster.set(hand.rayOrigin, hand.dir);
      const hit = this.raycaster.intersectObjects(meshes, false)[0];
      if (!hit || hit.distance > 8) {
        line.visible = dot.visible = false;
        return;
      }
      this.captured.add(hand);
      line.visible = dot.visible = true;
      line.scale.z = hit.distance;
      dot.position.copy(hit.point);
      const panel = hit.object.userData.panel;
      hovered.set(panel, panel.hitIndex(hit.uv));
      if (hand.state.trigger.down) this._click(panel, hit.uv, hand);
    });
    for (const p of this.panels) {
      p.setHover(hovered.has(p) ? hovered.get(p) : -1);
      p.update();
    }
  }
}
