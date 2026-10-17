import * as THREE from 'three';
import { Hand } from './input.js';
import { UI, Label } from './ui3d.js';
import { RemoteAvatar } from './avatar.js';
import { Particles } from './env.js';
import { r3, r4 } from './sync.js';
import { GAMES } from '../games/index.js';
import { POSE_HZ, COLORS } from '../config.js';

const MENU_HOLD_S = 1.2;
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

// Owns the renderer, the player rig, input, the partner avatar and the current game.
// Game switching is host-driven: the host sends {id, seq}; game messages carry seq so
// stale messages from a previous game are dropped.
export class App {
  constructor(net, sfx) {
    this.net = net;
    this.sfx = sfx;
    this.time = 0;
    this.poseAcc = 0;
    this.menuHold = 0;
    this.gameSeq = 0;
    this.gameId = null;
    this.gameOpts = {};
    this.game = null;
    this.loggedError = false;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setSize(window.innerWidth, window.innerHeight);
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local-floor');
    r.xr.setFoveation(1);
    document.body.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 1000);
    this.camera.position.set(0, 1.6, 0);
    this.camera.rotation.order = 'YXZ';
    this.rig = new THREE.Group();
    this.rig.add(this.camera);
    this.scene.add(this.rig);

    this.hands = [new Hand(r, 0, this.rig), new Hand(r, 1, this.rig)];
    this.ui = new UI(this);
    this.particles = new Particles(this.scene);
    this.avatar = new RemoteAvatar(this.scene);

    this.toastLabel = new Label('', { w: 1.4, h: 0.32, res: 768, size: 0.42, bg: 'rgba(5,8,20,0.75)' });
    this.toastLabel.mesh.position.set(0, -0.22, -1.3);
    this.toastLabel.mesh.renderOrder = 999;
    this.toastLabel.mesh.material.depthTest = false;
    this.toastLabel.mesh.visible = false;
    this.camera.add(this.toastLabel.mesh);
    this.toastTime = 0;

    this.lastFrame = performance.now();
    this._wireNet();
    this._wireDesktop();
    window.addEventListener('resize', () => {
      if (r.xr.isPresenting) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      r.setSize(window.innerWidth, window.innerHeight);
    });

    this.applyColors();
    this.startGame('lobby', 0);
    if (net.connected) this.onPartnerConnect();
    r.setAnimationLoop(() => this.frame());
  }

  get role() { return this.net.role; }
  get mySide() { return this.net.role === 'guest' ? 'guest' : 'host'; }
  get otherSide() { return this.mySide === 'host' ? 'guest' : 'host'; }
  get myColor() { return COLORS[this.mySide]; }
  get partnerColor() { return COLORS[this.otherSide]; }

  hand(handedness) { return this.hands.find((h) => h.handedness === handedness && h.connected) || null; }

  applyColors() {
    for (const h of this.hands) h.setColor(this.myColor);
    this.avatar.setColor(this.partnerColor);
  }

  _wireNet() {
    const net = this.net;
    net.on('pose', (d, ts) => this.avatar.push(ts, d.p, d.h));
    net.on('game', (d) => {
      if (this.role !== 'guest') return;
      if (d.seq === this.gameSeq && d.id === this.gameId) return;
      this.startGame(d.id, d.seq, d.opts);
    });
    net.on('pickGame', (d) => { if (this.role === 'host') this.requestGame(d.id, d.opts); });
    net.on('hello', () => {
      if (this.role === 'host') net.send('game', { id: this.gameId, seq: this.gameSeq, opts: this.gameOpts });
    });
    net.on('g', (d) => {
      if (d.s !== this.gameSeq || !this.game) return;
      try { this.game.onNet(d.k, d.d); } catch (e) { console.error('[game] onNet failed', d.k, e); }
    });
    net.on('connect', () => this.onPartnerConnect());
    net.on('disconnect', () => this.onPartnerDisconnect());
  }

  onPartnerConnect() {
    this.applyColors();
    this.avatar.reset();
    this.avatar.setVisible(true);
    this.toast('Partner connected!');
    this.sfx.powerup();
    // The host restarts whatever is running so both players start it together as 2-player.
    if (this.role === 'guest') this.net.send('hello', {});
    else this.requestGame(this.gameId || 'lobby', this.gameOpts);
  }

  onPartnerDisconnect() {
    this.avatar.setVisible(false);
    this.applyColors();
    this.toast(this.role === 'host' ? 'Partner left. They can rejoin with the same code.' : 'Disconnected from the room.', 4);
    this.requestGame('lobby');
  }

  // Ask to switch games. The guest asks the host; the host switches and tells the guest.
  requestGame(id, opts = {}) {
    if (this.role === 'guest') {
      this.net.send('pickGame', { id, opts });
      return;
    }
    const seq = this.gameSeq + 1;
    this.startGame(id, seq, opts);
    this.net.send('game', { id, seq, opts });
  }

  startGame(id, seq, opts = {}) {
    const GameClass = GAMES[id];
    if (!GameClass) return;
    if (this.game) {
      try { this.game.dispose(); } catch (e) { console.error('[game] dispose failed', e); }
    }
    this.game = null;
    this.ui.clear();
    this.gameId = id;
    this.gameSeq = seq;
    this.gameOpts = opts;
    this.scene.background = new THREE.Color(0x02030a);
    this.scene.fog = null;
    this.setRig(0, 0, 0, 0);
    for (const h of this.hands) h.visual.visible = true;
    this.avatar.setHandDotsVisible(true);
    this.menuHold = 0;
    this.game = new GameClass(this, opts);
  }

  // Send a message to the partner's copy of the current game.
  sendGame(kind, data = {}, reliable = true) {
    return this.net.send('g', { s: this.gameSeq, k: kind, d: data }, reliable);
  }

  setRig(x, y, z, yaw = 0) {
    this.rig.position.set(x, y, z);
    this.rig.rotation.set(0, yaw, 0);
    this.rig.updateMatrixWorld(true);
    this.resetHandTracking();
  }

  resetHandTracking() { for (const h of this.hands) h.fresh = true; }

  toast(text, seconds = 2.5) {
    this.toastLabel.set(text);
    this.toastLabel.mesh.visible = true;
    this.toastTime = seconds;
  }

  async enterVR() {
    if (!navigator.xr) return false;
    const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    if (!ok) return false;
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    await this.renderer.xr.setSession(session);
    session.addEventListener('end', () => this.onSessionEnd?.());
    return true;
  }

  _wireDesktop() {
    // Drag to look around when not in VR (spectating / testing on a PC).
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; this.dragged = false; });
    window.addEventListener('pointerup', () => { down = null; });
    el.addEventListener('pointermove', (e) => {
      if (!down || this.renderer.xr.isPresenting) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.dragged = true;
      down = { x: e.clientX, y: e.clientY };
      this.camera.rotation.y -= dx * 0.004;
      this.camera.rotation.x = THREE.MathUtils.clamp(this.camera.rotation.x - dy * 0.004, -1.4, 1.4);
    });
  }

  _sendPose(dt) {
    if (!this.net.connected) return;
    this.poseAcc += dt;
    if (this.poseAcc < 1 / POSE_HZ) return;
    this.poseAcc = 0;
    const p = [];
    const put = (obj) => {
      obj.getWorldPosition(_p);
      obj.getWorldQuaternion(_q);
      p.push(r3(_p.x), r3(_p.y), r3(_p.z), r4(_q.x), r4(_q.y), r4(_q.z), r4(_q.w));
    };
    put(this.camera);
    const left = this.hand('left'), right = this.hand('right');
    put(left ? left.grip : this.camera);
    put(right ? right.grip : this.camera);
    this.net.send('pose', { p, h: [left ? 1 : 0, right ? 1 : 0] }, false);
  }

  _updateMenuHold(dt) {
    const holding = this.hands.some((h) => h.connected && h.state.b.pressed);
    if (!holding || this.gameId === 'lobby') {
      this.menuHold = 0;
      return;
    }
    this.menuHold += dt;
    if (this.menuHold >= MENU_HOLD_S) {
      this.menuHold = 0;
      for (const h of this.hands) h.pulse(0.6, 80);
      this.requestGame('lobby');
    }
  }

  frame() {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 1 / 20);
    this.lastFrame = now;
    this.time += dt;
    try {
      for (const h of this.hands) h.update(dt);
      this._updateMenuHold(dt);
      this.ui.update(dt);
      this.game?.update(dt, this.time);
      this.particles.update(dt);
      this.avatar.update();
      this._sendPose(dt);
      if (this.toastTime > 0) {
        this.toastTime -= dt;
        if (this.toastTime <= 0) this.toastLabel.mesh.visible = false;
      }
      this.sfx.updateListener(this.camera);
    } catch (e) {
      if (!this.loggedError) console.error('[app] frame error', e);
      this.loggedError = true;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
