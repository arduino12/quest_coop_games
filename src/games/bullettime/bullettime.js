import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { glowMat } from '../../core/env.js';
import { distPointSeg, segHitsBody } from '../../core/geom.js';
import { EntityBuffer, ClockSync, r2 } from '../../core/sync.js';
import { INTERP_DELAY_MS } from '../../config.js';
import { rng } from '../starship/logic.js';
import {
  SHOT_BOOST, AMMO, GUN_RESPAWN, PUNCH_SPEED, THROW_SPEED, PLAYER_BULLET_SPEED, COVER,
  timeScale, motionOf, levelConfig, standoff, spawnPoint, insideCover,
} from './logic.js';

const RIG_X = { host: -0.5, guest: 0.5 };
const ENEMY_HEAD_Y = 1.6;
const _v = new THREE.Vector3();
const FWD = new THREE.Vector3(0, 0, -1);

function enemyHit(a, b, e, r) {
  // Segment a-b against an enemy at e: head sphere and body capsule.
  if (distPointSeg([e[0], ENEMY_HEAD_Y, e[2]], a, b) < 0.15 + r) return true;
  for (let y = 0.4; y <= 1.3; y += 0.15) if (distPointSeg([e[0], y, e[2]], a, b) < 0.24 + r) return true;
  return false;
}

// Time moves only as fast as the players move. The host runs enemies and bullets in game time;
// each player judges whether enemy bullets hit them, and their own punches.
export class BulletTime extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.otherSide = app.otherSide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.level = 1;
    this.phase = 'ready'; // ready -> fight -> clear | dead
    this.phaseT = 2.5;
    this.scale = 1;
    this.boostT = 0;
    this.theirMotion = 0;
    this.enemies = new Map();
    this.bullets = new Map();
    this.views = new Map();
    this.nextId = 1;
    this.spawned = 0;
    this.killed = 0;
    this.spawnT = 0;
    this.guns = { host: { ammo: AMMO, available: true, held: false, respawn: 0 }, guest: { ammo: AMMO, available: true, held: false, respawn: 0 } };
    this.myHand = -1;
    this.prevHead = null;
    this.motionAcc = 0;
    this.sendAcc = 0;
    this.buf = new EntityBuffer();
    this.clock = new ClockSync();
    this.r = rng(Math.floor(Math.random() * 1e9));

    this.buildArena();
    this.buildGuns();
    app.setRig(this.solo ? 0 : RIG_X[this.mySide], 0, 0, 0);
    this.gunSpot = new THREE.Vector3(app.rig.position.x + 0.25, 1.05, -0.35);
    app.toast('Time moves only when YOU move.\nGrab the gun with the grip, trigger shoots, throw it when empty.', 5);
    if (!this.isHost) app.sendGame('join');
  }

  // ---------- scene ----------

  buildArena() {
    const root = this.root;
    this.app.scene.background = new THREE.Color(0xf0f0f0);
    this.app.scene.fog = new THREE.Fog(0xf0f0f0, 12, 30);
    root.add(new THREE.HemisphereLight(0xffffff, 0x9a9a9a, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(3, 8, 4);
    root.add(sun);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 48), new THREE.MeshLambertMaterial({ color: 0xdcdcdc }));
    floor.rotation.x = -Math.PI / 2;
    root.add(floor);
    const grey = new THREE.MeshLambertMaterial({ color: 0xb8b8b8, flatShading: true });
    for (const [x, z, hx, hz, h] of COVER) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, h, hz * 2), grey);
      box.position.set(x, h / 2, z);
      root.add(box);
    }
    this.mats = {
      enemy: new THREE.MeshLambertMaterial({ color: 0xe0201a, flatShading: true }),
      gun: new THREE.MeshLambertMaterial({ color: 0x1a1a1a }),
      enemyBullet: glowMat(0x111111),
      myBullet: glowMat(0x2266ff),
      trail: new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.6 }),
    };
    this.label = new Label('', { w: 1.6, h: 0.16, res: 1024, size: 0.6, color: '#333333' });
    this.label.mesh.position.set(0, 2.6, -3);
    root.add(this.label.mesh);
    this.panel = this.app.ui.add(new Panel({ w: 1.1, h: 0.62, cols: 2, accent: '#e0201a' }));
    this.panel.mesh.position.set(0, 1.5, -1.6);
    this.panel.mesh.visible = false;
    root.add(this.panel.mesh);
  }

  makeGun() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.05, 0.17), this.mats.gun);
    body.position.z = -0.04;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.035), this.mats.gun);
    grip.position.set(0, -0.055, 0.03);
    grip.rotation.x = 0.25;
    g.add(body, grip);
    return g;
  }

  buildGuns() {
    this.myGun = this.makeGun();
    this.root.add(this.myGun);
    this.myGunHeld = this.app.hands.map((h) => {
      const g = this.attach(h.ray, this.makeGun());
      g.visible = false;
      return g;
    });
    this.theirGun = this.attach(this.app.avatar.hands.right, this.makeGun());
    this.theirGun.visible = false;
  }

  makeEnemy() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.75, 0.24), this.mats.enemy);
    body.position.y = 1.05;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.7, 0.2), this.mats.enemy);
    legs.position.y = 0.35;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 0), this.mats.enemy);
    head.position.y = ENEMY_HEAD_Y;
    const arm = new THREE.Group();
    arm.position.set(0.2, 1.35, 0);
    const limb = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.5), this.mats.enemy);
    limb.position.z = 0.25;
    const gun = this.makeGun();
    gun.rotation.y = Math.PI;
    gun.position.z = 0.55;
    arm.add(limb, gun);
    g.add(body, legs, head, arm);
    g.userData.arm = arm;
    return g;
  }

  // ---------- my body ----------

  myHead() { return this.app.camera.getWorldPosition(new THREE.Vector3()); }

  myMotion(dt) {
    const head = this.myHead();
    const headSpeed = this.prevHead && dt > 0 ? head.distanceTo(this.prevHead) / dt : 0;
    this.prevHead = head;
    return motionOf(Math.min(headSpeed, 5), this.app.hands.filter((h) => h.connected).map((h) => Math.min(h.vel.length(), 6)));
  }

  updateHands(dt) {
    const app = this.app;
    const gun = this.guns[this.mySide];
    app.hands.forEach((hand, i) => {
      if (!hand.connected) return;
      // Grab the gun from its spot.
      if (hand.state.squeeze.down && this.myHand < 0 && gun.available && hand.pos.distanceTo(this.gunSpot) < 0.2) {
        this.myHand = i;
        hand.pulse(0.4, 30);
        this.gunAction('grab');
      }
      if (this.myHand === i && !hand.state.squeeze.pressed) {
        this.myHand = -1;
        if (hand.vel.length() > THROW_SPEED) {
          this.gunAction('throw', { o: hand.pos.toArray().map(r2), v: hand.vel.toArray().map((c) => r2(c * 1.4)) });
          this.app.sfx.whoosh(hand.pos);
        } else this.gunAction('drop');
      }
      // Shoot.
      if (this.myHand === i && hand.state.trigger.down && this.phase === 'fight') {
        if (gun.ammo > 0) {
          const o = hand.rayOrigin.clone().addScaledVector(hand.dir, 0.12);
          this.gunAction('shot', { o: o.toArray().map(r2), d: hand.dir.toArray().map((c) => Math.round(c * 1000) / 1000) });
          gun.ammo--;
          app.sfx.noise({ dur: 0.12, vol: 0.5, f: 2500, pos: o });
          app.sfx.tone({ f: 120, f2: 50, dur: 0.15, vol: 0.4, pos: o });
          hand.pulse(1, 60);
          app.particles.burst(o, 0xffaa33, 8, 1.5, 0.15);
        } else {
          app.sfx.tone({ f: 900, dur: 0.03, type: 'square', vol: 0.1 });
          app.toast('Empty! Throw the gun at them', 1.5);
        }
      }
      // Punch with the free hand.
      if (this.myHand !== i && this.phase === 'fight' && hand.vel.length() > PUNCH_SPEED) {
        const p = hand.pos.toArray();
        for (const [id, e] of this.enemyPositions()) {
          if (enemyHit(p, p, e, 0.08)) {
            hand.pulse(1, 80);
            if (this.isHost) this.kill(id);
            else this.app.sendGame('punch', { id });
            break;
          }
        }
      }
    });
  }

  gunAction(kind, data = {}) {
    if (this.isHost) this.applyGun(this.mySide, kind, data);
    else this.app.sendGame('gun', { kind, ...data });
    if (kind === 'throw') this.guns[this.mySide].available = false;
  }

  // Host: what a player did with their gun.
  applyGun(side, kind, d) {
    const g = this.guns[side];
    if (kind === 'grab') g.held = true;
    else if (kind === 'drop') g.held = false;
    else if (kind === 'throw') {
      g.held = false;
      g.available = false;
      g.respawn = GUN_RESPAWN;
      this.addBullet({ kind: 'gun', p: d.o, v: d.v, owner: side, enemy: false, life: 3 });
    } else if (kind === 'shot' && this.phase === 'fight') {
      if (side !== this.mySide) g.ammo = Math.max(0, g.ammo - 1);
      this.addBullet({ kind: 'bullet', p: d.o, v: d.d.map((c) => c * PLAYER_BULLET_SPEED), owner: side, enemy: false, life: 2 });
      this.boostT = SHOT_BOOST;
    }
  }

  // ---------- host simulation ----------

  addBullet(b) {
    b.id = this.nextId++;
    b.p = b.p.slice();
    b.v = b.v.slice();
    this.bullets.set(b.id, b);
  }

  heads() {
    const h = { [this.mySide]: this.myHead().toArray() };
    if (!this.solo) h[this.otherSide] = this.app.avatar.head.getWorldPosition(new THREE.Vector3()).toArray();
    return h;
  }

  spawnEnemy(cfg) {
    let p;
    for (let k = 0; k < 10; k++) {
      p = spawnPoint(this.r, this.level);
      if (!insideCover(p, 0.6)) break;
    }
    const id = this.nextId++;
    this.enemies.set(id, { id, p, yaw: 0, state: 'walk', t: 0, range: 3.5 + this.r() * 2.5 });
    this.spawned++;
  }

  hostSim(dt) {
    const cfg = levelConfig(this.level);
    const gdt = dt * this.scale;
    const heads = this.heads();
    const sides = Object.keys(heads);
    if (this.phase === 'fight') {
      this.spawnT -= gdt;
      if (this.spawnT <= 0 && this.enemies.size < cfg.concurrent && this.spawned < cfg.total) {
        this.spawnT = 1.5;
        this.spawnEnemy(cfg);
      }
    }
    for (const e of this.enemies.values()) {
      // Target the nearest player.
      const target = sides.map((s) => heads[s]).sort((a, b) => Math.hypot(a[0] - e.p[0], a[2] - e.p[2]) - Math.hypot(b[0] - e.p[0], b[2] - e.p[2]))[0];
      e.yaw = Math.atan2(target[0] - e.p[0], target[2] - e.p[2]);
      if (e.state === 'walk') {
        const goal = standoff(e.p, target, e.range);
        const dx = goal[0] - e.p[0], dz = goal[2] - e.p[2];
        const d = Math.hypot(dx, dz);
        const step = Math.min(d, cfg.walk * gdt);
        if (d > 1e-6) { e.p[0] += (dx / d) * step; e.p[2] += (dz / d) * step; }
        if (d < 0.15) { e.state = 'aim'; e.t = cfg.aimTime; }
      } else if (e.state === 'aim') {
        e.t -= gdt;
        if (e.t <= 0) {
          const muzzle = [e.p[0] + Math.sin(e.yaw) * 0.6 + Math.cos(e.yaw) * 0.2, 1.35, e.p[2] + Math.cos(e.yaw) * 0.6 - Math.sin(e.yaw) * 0.2];
          const aim = [target[0] + (this.r() - 0.5) * cfg.spread * 2, target[1] - 0.05 + (this.r() - 0.5) * cfg.spread * 2, target[2] + (this.r() - 0.5) * cfg.spread * 2];
          const dir = [aim[0] - muzzle[0], aim[1] - muzzle[1], aim[2] - muzzle[2]];
          const l = Math.hypot(...dir);
          this.addBullet({ kind: 'bullet', p: muzzle, v: dir.map((c) => (c / l) * cfg.bulletSpeed), enemy: true, life: 6 });
          this.fx('eshot', muzzle);
          e.state = 'cool';
          e.t = cfg.cooldown;
        }
      } else if (e.state === 'cool') {
        e.t -= gdt;
        if (e.t <= 0) {
          e.state = this.r() < 0.3 ? 'walk' : 'aim';
          e.range = 3.5 + this.r() * 2.5;
          e.t = cfg.aimTime;
        }
      }
    }
    for (const b of [...this.bullets.values()]) {
      const prev = b.p.slice();
      if (b.kind === 'gun') b.v[1] -= 9.8 * gdt;
      for (let k = 0; k < 3; k++) b.p[k] += b.v[k] * gdt;
      b.life -= gdt;
      if (b.life <= 0 || b.p[1] < 0 || insideCover(b.p) || Math.hypot(b.p[0], b.p[2]) > 14) { this.bullets.delete(b.id); continue; }
      if (!b.enemy) {
        for (const [id, e] of this.enemies) {
          if (enemyHit(prev, b.p, e.p, b.kind === 'gun' ? 0.12 : 0.03)) {
            this.kill(id);
            this.bullets.delete(b.id);
            break;
          }
        }
      } else if (this.phase === 'fight' && segHitsBody(prev, b.p, heads[this.mySide])) {
        this.bullets.delete(b.id);
        this.died(this.mySide);
      }
    }
    for (const side of ['host', 'guest']) {
      const g = this.guns[side];
      if (!g.available) {
        g.respawn -= gdt;
        if (g.respawn <= 0) { g.available = true; g.ammo = AMMO; }
      }
    }
    if (this.phase === 'fight' && this.killed >= cfg.total) this.setPhase('clear');
  }

  kill(id) {
    const e = this.enemies.get(id);
    if (!e) return;
    this.enemies.delete(id);
    this.killed++;
    this.fx('shatter', [e.p[0], 1.1, e.p[2]]);
  }

  died(side) {
    if (this.phase !== 'fight') return;
    if (this.isHost) this.setPhase('dead', side);
    else this.app.sendGame('dead');
  }

  fx(kind, p) {
    this.playFx(kind, p);
    if (!this.solo && this.isHost) this.app.sendGame('fx', { kind, p: p.map(r2) });
  }

  playFx(kind, p) {
    const sfx = this.app.sfx;
    if (kind === 'shatter') {
      this.app.particles.burst(p, 0xe0201a, 70, 3, 1.2, 4);
      sfx.noise({ dur: 0.4, vol: 0.5, f: 5000, type: 'highpass', pos: p });
      sfx.tone({ f: 1800, f2: 600, dur: 0.25, type: 'triangle', vol: 0.15, pos: p });
    } else if (kind === 'eshot') {
      sfx.noise({ dur: 0.1, vol: 0.35, f: 1800, pos: p });
      this.app.particles.burst(p, 0xffaa33, 6, 1, 0.12);
    }
  }

  setPhase(phase, who = null) {
    this.phase = phase;
    this.phaseT = phase === 'ready' ? 2.5 : 3;
    if (this.isHost && !this.solo) this.app.sendGame('phase', { phase, level: this.level, who });
    this.onPhase(who);
  }

  onPhase(who) {
    const app = this.app;
    if (this.phase === 'clear') { app.toast(`LEVEL ${this.level} CLEAR`, 2.5); app.sfx.goal(true); }
    else if (this.phase === 'dead') {
      app.toast(who === this.mySide || this.solo ? 'You got shot!' : 'Your partner got shot!', 2.5);
      app.sfx.boom(null, true);
      for (const h of app.hands) h.pulse(1, 300);
    } else if (this.phase === 'ready') app.toast(`LEVEL ${this.level}`, 2);
  }

  // Host: phase timers between levels.
  hostPhases(dt) {
    if (this.phase === 'fight') return;
    this.phaseT -= dt;
    if (this.phaseT > 0) return;
    if (this.phase === 'clear') this.level++;
    if (this.phase === 'clear' || this.phase === 'dead') {
      this.enemies.clear();
      this.bullets.clear();
      this.spawned = 0;
      this.killed = 0;
      this.spawnT = 0.5;
      for (const g of Object.values(this.guns)) { g.ammo = AMMO; g.available = true; }
      this.setPhase('ready');
    } else if (this.phase === 'ready') this.setPhase('fight');
  }

  // ---------- networking ----------

  enemyPositions() {
    if (this.isHost) return [...this.enemies].map(([id, e]) => [id, e.p]);
    return [...this.views].filter(([, v]) => v.kind === 'enemy').map(([id, v]) => [id, [v.mesh.position.x, 0, v.mesh.position.z]]);
  }

  sendSnap() {
    if (this.solo) return;
    this.app.sendGame('snap', {
      ts: performance.now(),
      sc: r2(this.scale),
      e: [...this.enemies.values()].map((e) => [e.id, r2(e.p[0]), r2(e.p[2]), r2(e.yaw), e.state === 'aim' ? 1 : 0]),
      b: [...this.bullets.values()].map((b) => [b.id, b.kind === 'gun' ? 1 : b.enemy ? 2 : 0, ...b.p.map(r2), ...b.v.map(r2)]),
      g: this.guns,
      k: [this.killed, levelConfig(this.level).total],
    }, false);
  }

  onNet(k, d) {
    if (this.isHost) {
      if (k === 'join') this.app.sendGame('phase', { phase: this.phase, level: this.level });
      else if (k === 'motion') this.theirMotion = d.m;
      else if (k === 'gun') this.applyGun(this.otherSide, d.kind, d);
      else if (k === 'punch') this.kill(d.id);
      else if (k === 'dead') this.setPhase('dead', this.otherSide);
      return;
    }
    if (k === 'snap') {
      this.clock.update(d.ts, performance.now());
      this.buf.push(d.ts, d.e);
      this.scale = d.sc;
      this.remoteBullets = d.b.map(([id, kind, x, y, z, vx, vy, vz]) => ({ id, kind, p: [x, y, z], v: [vx, vy, vz] }));
      const mine = this.guns.guest;
      this.guns = d.g;
      // Keep my own quick-changing gun state until the host catches up.
      if (mine.ammo < this.guns.guest.ammo && this.guns.guest.available) this.guns.guest.ammo = mine.ammo;
      this.killedInfo = d.k;
    } else if (k === 'phase') {
      this.level = d.level;
      this.phase = d.phase;
      this.phaseT = 3;
      if (d.phase === 'ready') this.guns.guest.ammo = AMMO;
      this.onPhase(d.who);
    } else if (k === 'fx') this.playFx(d.kind, d.p);
  }

  // ---------- drawing ----------

  view(id, kind) {
    let v = this.views.get(id);
    if (!v) {
      let mesh;
      if (kind === 'enemy') mesh = this.makeEnemy();
      else if (kind === 1) mesh = this.makeGun();
      else {
        mesh = new THREE.Group();
        const slug = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.06, 4, 8), kind === 2 ? this.mats.enemyBullet : this.mats.myBullet);
        slug.rotation.x = Math.PI / 2;
        const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0.8)]), this.mats.trail);
        mesh.add(slug, trail);
      }
      this.root.add(mesh);
      v = { kind, mesh };
      this.views.set(id, v);
    }
    v.seen = true;
    return v;
  }

  draw(dt) {
    for (const v of this.views.values()) v.seen = false;
    let enemies, bullets;
    if (this.isHost) {
      enemies = [...this.enemies.values()].map((e) => [e.id, e.p[0], e.p[2], e.yaw, e.state === 'aim' ? 1 : 0]);
      bullets = [...this.bullets.values()].map((b) => ({ id: b.id, kind: b.kind === 'gun' ? 1 : b.enemy ? 2 : 0, p: b.p, v: b.v }));
    } else {
      const m = this.buf.size ? this.buf.sample(this.clock.remoteNow(performance.now()) - INTERP_DELAY_MS) : new Map();
      enemies = [...m].map(([id, v]) => [id, ...v]);
      // Coast bullets between snapshots at the current time scale.
      for (const b of this.remoteBullets || []) for (let k = 0; k < 3; k++) b.p[k] += b.v[k] * dt * this.scale;
      bullets = this.remoteBullets || [];
    }
    for (const [id, x, z, yaw, aiming] of enemies) {
      const v = this.view(id, 'enemy');
      v.mesh.position.set(x, 0, z);
      v.mesh.rotation.y = yaw;
      v.mesh.userData.arm.rotation.x = aiming ? 0 : 0.9;
    }
    for (const b of bullets) {
      const v = this.view(b.id, b.kind);
      v.mesh.position.set(...b.p);
      _v.set(...b.v);
      if (_v.lengthSq() > 1e-6) v.mesh.quaternion.setFromUnitVectors(FWD, _v.normalize()); // trail streams behind
    }
    for (const [id, v] of this.views) if (!v.seen) { this.root.remove(v.mesh); this.views.delete(id); }
    // Guest: enemy bullets reaching me are judged here, on my own headset.
    if (!this.isHost && this.phase === 'fight') {
      const head = this.myHead().toArray();
      for (const b of bullets) {
        if (b.kind !== 2) continue;
        const prev = b.p.map((c, k) => c - b.v[k] * dt * this.scale * 2);
        if (segHitsBody(prev, b.p, head)) { this.died(this.mySide); break; }
      }
    }
  }

  drawGuns(t) {
    const mine = this.guns[this.mySide];
    this.myGunHeld.forEach((g, i) => { g.visible = this.myHand === i; });
    this.app.hands.forEach((h, i) => { h.visual.visible = this.myHand !== i; });
    this.myGun.visible = this.myHand < 0 && mine.available;
    this.myGun.position.copy(this.gunSpot).add(_v.set(0, Math.sin(t * 2) * 0.01, 0));
    this.myGun.rotation.y = t * 0.5;
    this.theirGun.visible = !this.solo && this.guns[this.otherSide].held;
  }

  update(dt, t) {
    const m = this.myMotion(dt);
    if (this.isHost) {
      this.boostT -= dt;
      this.scale = this.boostT > 0 ? 1 : this.phase === 'fight' ? timeScale(Math.max(m, this.theirMotion)) : 1;
      this.hostSim(dt);
      this.hostPhases(dt);
      this.sendAcc += dt;
      if (this.sendAcc >= 0.05) { this.sendAcc = 0; this.sendSnap(); }
    } else {
      this.motionAcc += dt;
      if (this.motionAcc >= 0.1) { this.motionAcc = 0; this.app.sendGame('motion', { m: r2(m) }, false); }
    }
    this.updateHands(dt);
    this.draw(dt);
    this.drawGuns(t);
    // The world fades toward blue when time is slow.
    const slow = 1 - this.scale;
    this.app.scene.background.setRGB(0.94 - slow * 0.25, 0.94 - slow * 0.12, 0.94);
    if (this.app.scene.fog) this.app.scene.fog.color.copy(this.app.scene.background);
    const gun = this.guns[this.mySide];
    const kills = this.isHost ? `${this.killed}/${levelConfig(this.level).total}` : this.killedInfo ? `${this.killedInfo[0]}/${this.killedInfo[1]}` : '';
    this.label.set(`LEVEL ${this.level}   ·   KILLS ${kills}   ·   AMMO ${gun.available ? gun.ammo : '-'}   ·   TIME ${Math.round(this.scale * 100)}%`);
  }
}
