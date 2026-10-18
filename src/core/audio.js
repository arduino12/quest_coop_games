import * as THREE from 'three';

// Tiny synthesized sound effects (no audio files). Positional when `pos` is given.
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
  }

  // Must be called from a user gesture (click) before any sound can play.
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      this.ctx.resume();
    } catch (e) {
      console.warn('[sfx] audio unavailable', e);
    }
  }

  get ready() { return this.ctx && this.ctx.state === 'running'; }

  updateListener(camera) {
    if (!this.ready) return;
    camera.getWorldPosition(_p);
    camera.getWorldQuaternion(_q);
    _f.set(0, 0, -1).applyQuaternion(_q);
    _u.set(0, 1, 0).applyQuaternion(_q);
    // The very first XR frames can report an invalid pose; skip them.
    if (![_p.x, _p.y, _p.z, _f.x, _f.y, _f.z, _u.x, _u.y, _u.z].every(Number.isFinite)) return;
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = _p.x; L.positionY.value = _p.y; L.positionZ.value = _p.z;
      L.forwardX.value = _f.x; L.forwardY.value = _f.y; L.forwardZ.value = _f.z;
      L.upX.value = _u.x; L.upY.value = _u.y; L.upZ.value = _u.z;
    } else {
      L.setPosition(_p.x, _p.y, _p.z);
      L.setOrientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z);
    }
  }

  _dest(pos) {
    if (!pos) return this.master;
    const pan = this.ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = 1.5;
    pan.maxDistance = 300;
    pan.rolloffFactor = 1;
    const x = pos.x ?? pos[0], y = pos.y ?? pos[1], z = pos.z ?? pos[2];
    if (pan.positionX) { pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z; }
    else pan.setPosition(x, y, z);
    pan.connect(this.master);
    return pan;
  }

  tone({ f = 440, f2 = null, dur = 0.12, type = 'sine', vol = 0.25, pos = null, delay = 0, attack = 0.005 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t0);
    if (f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this._dest(pos));
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  noise({ dur = 0.3, vol = 0.3, f = 1500, f2 = null, q = 0.8, type = 'lowpass', pos = null, delay = 0 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f, t0);
    if (f2) filt.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(this._dest(pos));
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  click() { this.tone({ f: 900, f2: 1300, dur: 0.05, type: 'square', vol: 0.06 }); }
  hit(pos, speed = 5) {
    const f = 260 + speed * 45;
    this.tone({ f, f2: f * 0.5, dur: 0.14, type: 'triangle', vol: 0.4, pos });
    this.noise({ dur: 0.05, vol: 0.2, f: 3500, pos });
  }
  bounce(pos) { this.tone({ f: 200, f2: 150, dur: 0.06, type: 'sine', vol: 0.15, pos }); }
  goal(good) {
    const notes = good ? [523, 659, 784, 1047] : [392, 330, 262];
    notes.forEach((f, i) => this.tone({ f, dur: 0.18, type: 'square', vol: 0.08, delay: i * 0.1 }));
  }
  boom(pos, big = false) {
    this.noise({ dur: big ? 1.1 : 0.55, vol: big ? 0.7 : 0.45, f: 1200, f2: 60, pos });
    this.tone({ f: 110, f2: 35, dur: big ? 0.7 : 0.4, type: 'sine', vol: 0.5, pos });
  }
  laser(pos) { this.tone({ f: 1500, f2: 260, dur: 0.12, type: 'sawtooth', vol: 0.09, pos }); }
  thunk(pos) {
    this.tone({ f: 170, f2: 70, dur: 0.12, type: 'sine', vol: 0.35, pos });
    this.noise({ dur: 0.06, vol: 0.12, f: 900, pos });
  }
  whoosh(pos) { this.noise({ dur: 0.4, vol: 0.3, f: 500, f2: 2500, type: 'bandpass', q: 1.5, pos }); }
  alarm() {
    this.tone({ f: 880, dur: 0.14, type: 'square', vol: 0.06 });
    this.tone({ f: 660, dur: 0.14, type: 'square', vol: 0.06, delay: 0.17 });
  }
  powerup() {
    [440, 660, 880, 1320].forEach((f, i) => this.tone({ f, dur: 0.12, type: 'triangle', vol: 0.15, delay: i * 0.07 }));
  }
}
