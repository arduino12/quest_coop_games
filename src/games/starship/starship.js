import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { Particles, edges, glowMat, lineMat } from '../../core/env.js';
import { EntityBuffer, SnapshotBuffer, ClockSync, r2 } from '../../core/sync.js';
import { COLORS, INTERP_DELAY_MS } from '../../config.js';
import {
  ET, LAT_SPEED, SPAWN_Z, ENGAGE_Z, PLASMA_SPEED, SHIELD_REGEN, REGEN_DELAY, BREACH_DRAIN, MAX_BREACHES,
  BREACH_SPOTS, waveConfig, asteroidHp, collisionDamage, scoreFor, applyDamage, raySphere, hitsShip, clampShip,
} from './logic.js';

const PILOT_X = -0.65;
const GUNNER_X = 0.65;
const STICK_BASE = new THREE.Vector3(PILOT_X + 0.3, 0.93, -0.45);
const STICK_LEN = 0.16;
const STARS = 500;
const BOLT_SPEED = 320;
const REPAIR_TIME = 1.2;
const BEST_KEY = 'qcg-starship-best';
const rand = (a, b) => a + Math.random() * (b - a);
const _o = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// Host simulates enemies, asteroids, damage and score. The pilot (host or guest) owns the
// ship's sideways position so steering has no lag. Each shooter detects hits on what they
// see and reports them (co-op, so we trust the shooter).
export class Starship extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.roles = { pilot: 'host', gunner: this.solo ? 'host' : 'guest' };
    this.phase = 'brief'; // brief -> play -> over
    this.ship = { x: 0, y: 0, vx: 0, vy: 0 };
    this.shipView = { x: 0, y: 0 };
    this.remoteShip = { x: 0, y: 0 };
    this.st = { shield: 100, hull: 100, score: 0, wave: 0, speed: 26 };
    this.ents = new Map(); // host simulation
    this.views = new Map(); // id -> { type, r, mesh, spin }
    this.breaches = new Map(); // id -> { id, spot, pos, group, ring }
    this.repair = new Map();
    this.repairedIds = new Set();
    this.buf = new EntityBuffer();
    this.shipBuf = new SnapshotBuffer({ stride: 2, quatOffset: -1 });
    this.clock = new ClockSync();
    this.cool = [0, 0];
    this.lastDamage = -99;
    this.nextId = 1;
    this.nextBreach = 1;
    this.wave = null;
    this.sendAcc = 0;
    this.shipAcc = 0;
    this.hudAcc = 0;
    this.sparkAcc = 0;
    this.hurt = 0;
    this.stick = { hand: -1, x: 0, y: 0 };
    this.best = Number(localStorage.getItem(BEST_KEY) || 0);

    this.space = new THREE.Group();
    this.root.add(this.space);
    this.fx = new Particles(this.space, { max: 700, size: 0.45 });
    this.bolts = [];

    this.makeAssets();
    this.buildSpace();
    this.buildCockpit();
    this.buildControls();
    this.buildGuns();
    this.buildHud();
    this.placeRig();
    this.refreshPanel();
    if (!this.isHost) app.sendGame('join');
  }

  get isPilot() { return this.roles.pilot === this.mySide; }
  get isGunner() { return this.roles.gunner === this.mySide; }

  // ---------- setup ----------

  makeAssets() {
    this.astGeo = new THREE.IcosahedronGeometry(1, 0);
    this.astMat = new THREE.MeshLambertMaterial({ color: 0x8a7a6a, flatShading: true });
    this.plasmaGeo = new THREE.SphereGeometry(0.35, 10, 8);
    this.plasmaMat = glowMat(0xff3355);
    this.boltGeo = new THREE.CylinderGeometry(0.03, 0.03, 2.5, 6);
    this.enemyParts = {
      body: new THREE.ConeGeometry(0.7, 2.4, 6),
      wing: new THREE.BoxGeometry(3.2, 0.1, 0.8),
      eye: new THREE.SphereGeometry(0.3, 10, 8),
      dark: new THREE.MeshLambertMaterial({ color: 0x2a2030, flatShading: true }),
      glow: glowMat(0xff2244),
    };
  }

  makeView(id, type, r) {
    let mesh;
    if (type === ET.asteroid) {
      mesh = new THREE.Mesh(this.astGeo, this.astMat);
      const k = 1 + (id % 7) * 0.05;
      mesh.scale.set(r * k, r, r * (2 - k));
    } else if (type === ET.enemy) {
      mesh = new THREE.Group();
      const body = new THREE.Mesh(this.enemyParts.body, this.enemyParts.dark);
      body.rotation.x = Math.PI / 2; // nose toward +z (the ship)
      const wing = new THREE.Mesh(this.enemyParts.wing, this.enemyParts.dark);
      const eye = new THREE.Mesh(this.enemyParts.eye, this.enemyParts.glow);
      eye.position.z = 0.9;
      const trim = edges(this.enemyParts.wing, 0xff2244);
      mesh.add(body, wing, eye, trim);
    } else {
      mesh = new THREE.Mesh(this.plasmaGeo, this.plasmaMat);
    }
    this.space.add(mesh);
    const v = { type, r, mesh, spin: 0.3 + (id % 5) * 0.2 };
    this.views.set(id, v);
    return v;
  }

  removeView(id) {
    const v = this.views.get(id);
    if (!v) return;
    this.space.remove(v.mesh);
    this.views.delete(id);
  }

  buildSpace() {
    const app = this.app;
    app.scene.background = new THREE.Color(0x020310);
    this.root.add(new THREE.HemisphereLight(0xaab8ff, 0x221a33, 1.0));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.6);
    sun.position.set(-4, 6, 3);
    this.root.add(sun);

    const planet = new THREE.Mesh(new THREE.SphereGeometry(70, 32, 24), new THREE.MeshLambertMaterial({ color: 0x4b2f9a }));
    planet.position.set(-170, -50, -520);
    this.root.add(planet);
    const ring = new THREE.Mesh(new THREE.RingGeometry(90, 120, 64), new THREE.MeshBasicMaterial({
      color: 0x8f7fff, side: THREE.DoubleSide, transparent: true, opacity: 0.35,
    }));
    ring.position.copy(planet.position);
    ring.rotation.set(1.2, 0.3, 0);
    this.root.add(ring);

    this.star = new Float32Array(STARS * 3);
    for (let i = 0; i < STARS; i++) {
      this.star[i * 3] = rand(-70, 70);
      this.star[i * 3 + 1] = rand(-45, 45);
      this.star[i * 3 + 2] = rand(-300, 20);
    }
    this.streakPos = new Float32Array(STARS * 6);
    const g = new THREE.BufferGeometry();
    this.streakAttr = new THREE.BufferAttribute(this.streakPos, 3);
    g.setAttribute('position', this.streakAttr);
    this.streaks = new THREE.LineSegments(g, lineMat(0xbfd0ff, 0.7));
    this.streaks.frustumCulled = false;
    this.space.add(this.streaks);
  }

  buildCockpit() {
    const root = this.root;
    const hull = new THREE.MeshLambertMaterial({ color: 0x1c2438 });
    const box = (w, h, d, x, y, z, rx = 0, trim = null) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(g, hull);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      root.add(m);
      if (trim !== null) {
        const t = edges(g, trim, 0.6);
        t.position.copy(m.position);
        t.rotation.copy(m.rotation);
        root.add(t);
      }
      return m;
    };
    box(3.4, 0.06, 3.0, 0, -0.03, 0.25);
    box(3.4, 0.86, 0.1, 0, 0.43, -1.05, 0, 0x22e6ff);
    box(3.2, 0.08, 0.55, 0, 0.88, -0.78, -0.3, 0x22e6ff);
    box(0.1, 2.5, 2.8, -1.75, 1.25, 0.35, 0, 0x3355ff);
    box(0.1, 2.5, 2.8, 1.75, 1.25, 0.35, 0, 0x3355ff);
    box(3.6, 2.5, 0.1, 0, 1.25, 1.7, 0, 0x3355ff);
    box(3.6, 0.1, 2.2, 0, 2.5, 0.6, 0, 0x3355ff);
    box(0.08, 1.65, 0.08, -1.7, 1.68, -1.05, 0, 0x22e6ff);
    box(0.08, 1.65, 0.08, 1.7, 1.68, -1.05, 0, 0x22e6ff);
    box(3.4, 0.08, 0.08, 0, 2.48, -1.05, 0, 0x22e6ff);
    const lamp = new THREE.PointLight(0xffe8d0, 1.2, 6, 1.5);
    lamp.position.set(0, 2.2, 0.4);
    root.add(lamp);

    for (const [x, name, color] of [[PILOT_X, 'PILOT', '#7dff8a'], [GUNNER_X, 'GUNNER', '#ff6b6b']]) {
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.36, 40), glowMat(new THREE.Color(color), 0.8));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(x, 0.01, 0.25);
      root.add(pad);
      const tag = new Label(name, { w: 0.4, h: 0.09, color });
      tag.mesh.position.set(x, 0.62, -0.995);
      root.add(tag.mesh);
    }

    // Where breaches can appear: dim panels on the walls.
    for (const s of BREACH_SPOTS) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({ color: 0x2a3350 }));
      panel.position.set(...s);
      panel.lookAt(0, 1.1, 0.3);
      root.add(panel);
    }

    // Red flash when the ship takes hull damage.
    this.hurtMesh = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), new THREE.MeshBasicMaterial({
      color: 0xff0022, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false,
    }));
    this.hurtMesh.renderOrder = 998;
    this.attach(this.app.camera, this.hurtMesh);
  }

  buildControls() {
    const metal = new THREE.MeshLambertMaterial({ color: 0x55607a });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.04, 16), metal);
    base.position.copy(STICK_BASE);
    this.root.add(base);
    this.pivot = new THREE.Group();
    this.pivot.position.copy(STICK_BASE);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, STICK_LEN, 8), metal);
    shaft.position.y = STICK_LEN / 2;
    this.knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), glowMat(0x7dff8a));
    this.knob.position.y = STICK_LEN;
    this.pivot.add(shaft, this.knob);
    this.root.add(this.pivot);
    this.knobRest = STICK_BASE.clone().add(new THREE.Vector3(0, STICK_LEN, 0));
  }

  buildGuns() {
    this.guns = this.app.hands.map((hand) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.14), new THREE.MeshLambertMaterial({ color: 0x3a4258 }));
      body.position.z = 0.06;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8), glowMat(this.app.myColor));
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = -0.03;
      const aim = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -0.1), new THREE.Vector3(0, 0, -30)]),
        lineMat(this.app.myColor, 0.25),
      );
      g.add(body, barrel, aim);
      g.visible = false;
      return this.attach(hand.ray, g);
    });
  }

  buildHud() {
    const screen = (x, w) => {
      const l = new Label('', { w, h: 0.2, res: 512, size: 0.7, bg: 'rgba(0,20,30,0.85)', color: '#7dffef' });
      l.mesh.position.set(x, 1.04, -0.93);
      l.mesh.rotation.x = -0.3;
      this.root.add(l.mesh);
      return l;
    };
    this.hudCenter = screen(0, 0.62);
    this.hudLeft = screen(-0.95, 0.5);
    this.hudRight = screen(0.95, 0.5);
    this.panel = this.app.ui.add(new Panel({ w: 1.3, h: 0.95, accent: '#7dff8a' }));
    this.panel.mesh.position.set(0, 1.6, -0.95);
    this.root.add(this.panel.mesh);
  }

  placeRig() {
    this.app.setRig(this.isPilot ? PILOT_X : GUNNER_X, 0, 0.25, 0);
  }

  refreshPanel() {
    const p = this.panel;
    if (this.phase === 'brief') {
      const you = this.solo ? 'PILOT + GUNNER' : this.isPilot ? 'PILOT' : 'GUNNER';
      p.set({
        title: 'STARSHIP BRIDGE',
        accent: '#7dff8a',
        cols: 2,
        lines: [
          `You are the ${you}.`,
          'Pilot: grab the joystick (or use the left thumbstick) to dodge.',
          'Gunner: aim with your hands, pull the triggers to shoot.',
          'Everyone: hold the grip on sparking panels to fix breaches.',
        ],
        buttons: [
          { label: 'Swap roles', enabled: !this.solo, onClick: () => this.swapRoles() },
          { label: 'Launch!', onClick: () => (this.isHost ? this.startRun() : this.app.sendGame('launch')) },
        ],
      });
      p.mesh.visible = true;
    } else if (this.phase === 'over') {
      p.set({
        title: 'SHIP DESTROYED',
        accent: '#ff6b6b',
        cols: 2,
        lines: [`You reached wave ${this.st.wave} with ${this.st.score} points.`, `Best: ${Math.max(this.best, this.st.score)}`],
        buttons: [
          { label: 'Fly again', onClick: () => this.app.requestGame('starship') },
          { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
        ],
      });
      p.mesh.visible = true;
    } else {
      p.mesh.visible = false;
    }
  }

  swapRoles() {
    if (this.solo || this.phase !== 'brief') return;
    if (!this.isHost) {
      this.app.sendGame('swap');
      return;
    }
    this.roles = { pilot: this.roles.gunner, gunner: this.roles.pilot };
    this.app.sendGame('roles', { roles: this.roles });
    this.placeRig();
    this.refreshPanel();
  }

  // ---------- host simulation ----------

  startRun() {
    if (this.phase === 'play') return;
    for (const id of [...this.views.keys()]) this.removeView(id);
    for (const id of [...this.breaches.keys()]) this.removeBreach(id);
    this.ents.clear();
    this.st = { shield: 100, hull: 100, score: 0, wave: 0, speed: 26 };
    this.phase = 'play';
    this.startWave(1);
    this.app.sendGame('start', { roles: this.roles });
    this.onStart();
  }

  onStart() {
    this.ship = { x: 0, y: 0, vx: 0, vy: 0 };
    this.refreshPanel();
    this.app.sfx.powerup();
  }

  startWave(n) {
    const cfg = waveConfig(n);
    this.wave = { n, t: 0, a: 0, e: 0, state: 'active', brk: 0, cfg };
    this.st.wave = n;
    this.st.speed = cfg.speed;
    this.announce(n === 1 ? 'Wave 1: here they come!' : `Wave ${n}`);
  }

  announce(text) {
    this.app.toast(text, 3);
    this.app.sendGame('msg', { text });
  }

  spawnAsteroid() {
    const r = rand(0.8, 2.6);
    const aimed = Math.random() < 0.3;
    const s = this.shipView;
    const p = [s.x + (aimed ? rand(-2, 2) : rand(-18, 18)), s.y + (aimed ? rand(-1.5, 1.5) : rand(-10, 10)), SPAWN_Z];
    this.ents.set(this.nextId, {
      id: this.nextId++, type: ET.asteroid, p, v: [rand(-1, 1), rand(-0.6, 0.6), rand(-2, 4)], r, hp: asteroidHp(r), t: 0,
    });
  }

  spawnEnemy() {
    const s = this.shipView;
    this.ents.set(this.nextId, {
      id: this.nextId++, type: ET.enemy, p: [s.x + rand(-20, 20), s.y + rand(-6, 8), SPAWN_Z], v: [0, 0, 0], r: 1.4, hp: 3, t: 0,
      state: 'in', ox: rand(-8, 8), oy: rand(-3, 4), ph: rand(0, 6), fire: this.wave.cfg.enemyFire * rand(0.5, 1.2), ft: 0,
    });
  }

  spawnPlasma(from, ship) {
    const d = [ship[0] - from[0], ship[1] - from[1], -from[2]];
    const l = Math.hypot(...d) || 1;
    this.ents.set(this.nextId, {
      id: this.nextId++, type: ET.plasma, p: from.slice(), v: d.map((c) => (c / l) * PLASMA_SPEED), r: 0.35, hp: 1, t: 0,
    });
  }

  enemyAI(e, dt, ship) {
    if (e.state === 'in') {
      e.p[2] += 45 * dt;
      if (e.p[2] >= ENGAGE_Z) e.state = 'fight';
    } else if (e.state === 'fight') {
      e.ft += dt;
      const target = [
        ship[0] + e.ox + Math.sin(e.t * 0.7 + e.ph) * 6,
        ship[1] + e.oy + Math.cos(e.t * 0.9 + e.ph) * 3,
        ENGAGE_Z + Math.sin(e.t * 0.5 + e.ph) * 6,
      ];
      const max = 9 * dt;
      for (let k = 0; k < 3; k++) e.p[k] += THREE.MathUtils.clamp(target[k] - e.p[k], -max, max);
      e.fire -= dt;
      if (e.fire <= 0) {
        e.fire = this.wave.cfg.enemyFire * rand(0.7, 1.3);
        this.spawnPlasma(e.p, ship);
      }
      if (e.ft > 18) e.state = 'out';
    } else {
      e.p[2] -= 50 * dt;
      e.p[1] += 6 * dt;
    }
  }

  hostSim(dt) {
    const w = this.wave;
    const cfg = w.cfg;
    if (w.state === 'active') {
      w.t += dt;
      while (w.a < cfg.asteroids && w.t >= (w.a * cfg.duration) / cfg.asteroids) { this.spawnAsteroid(); w.a++; }
      while (w.e < cfg.enemies && w.t >= 5 + (w.e * cfg.duration * 0.75) / cfg.enemies) { this.spawnEnemy(); w.e++; }
      const enemiesAlive = [...this.ents.values()].some((e) => e.type === ET.enemy);
      if (w.a >= cfg.asteroids && w.e >= cfg.enemies && !enemiesAlive && w.t > cfg.duration) {
        w.state = 'break';
        w.brk = 5;
        this.st.score += 250;
        this.announce(`Wave ${w.n} cleared! +250`);
      }
    } else {
      w.brk -= dt;
      if (w.brk <= 0) this.startWave(w.n + 1);
    }

    const V = this.st.speed;
    const ship = [this.shipView.x, this.shipView.y];
    for (const e of [...this.ents.values()]) {
      e.t += dt;
      if (e.type === ET.asteroid) {
        e.p[0] += e.v[0] * dt;
        e.p[1] += e.v[1] * dt;
        e.p[2] += (V + e.v[2]) * dt;
      } else if (e.type === ET.enemy) this.enemyAI(e, dt, ship);
      else for (let k = 0; k < 3; k++) e.p[k] += e.v[k] * dt;
      if (e.p[2] > 25 || e.p[2] < -330 || (e.type === ET.plasma && e.t > 7)) {
        this.ents.delete(e.id);
        continue;
      }
      if (hitsShip(e.p, e.r, ship)) {
        this.damage(collisionDamage(e.type, e.r));
        this.destroy(e, false);
      }
    }

    if (this.app.time - this.lastDamage > REGEN_DELAY) this.st.shield = Math.min(100, this.st.shield + SHIELD_REGEN * dt);
    this.st.hull = Math.max(0, this.st.hull - BREACH_DRAIN * this.breaches.size * dt);
    if (this.st.hull <= 0) this.gameOver();
  }

  damage(dmg) {
    const toHull = applyDamage(this.st, dmg);
    this.lastDamage = this.app.time;
    this.onHurt(toHull > 0);
    if (!this.solo) this.app.sendGame('hurt', { hull: toHull > 0 });
    if (toHull > 0 && this.breaches.size < MAX_BREACHES && Math.random() < 0.5) this.addBreach();
  }

  onHurt(hull) {
    this.hurt = hull ? 0.6 : 0.25;
    this.app.sfx.boom(null, false);
    for (const h of this.app.hands) h.pulse(hull ? 1 : 0.5, 120);
  }

  addBreach() {
    const used = new Set([...this.breaches.values()].map((b) => b.spot));
    const free = BREACH_SPOTS.map((_, i) => i).filter((i) => !used.has(i));
    if (!free.length) return;
    const spot = free[Math.floor(Math.random() * free.length)];
    this.makeBreach(this.nextBreach++, spot);
    this.announce('HULL BREACH!\nHold the grip on the sparking panel');
    this.app.sfx.alarm();
  }

  makeBreach(id, spot) {
    const pos = new THREE.Vector3(...BREACH_SPOTS[spot]);
    const group = new THREE.Group();
    group.position.copy(pos);
    group.lookAt(0, 1.1, 0.3);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xff2200 }));
    plate.position.z = 0.01;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.2, 32, 1, 0, 0.001), glowMat(0x7dff8a));
    ring.position.z = 0.02;
    group.add(plate, ring);
    this.root.add(group);
    this.breaches.set(id, { id, spot, pos, group, plate, ring });
  }

  removeBreach(id) {
    const b = this.breaches.get(id);
    if (!b) return;
    this.root.remove(b.group);
    this.breaches.delete(id);
    this.repair.delete(id);
  }

  destroy(e, byPlayer) {
    this.ents.delete(e.id);
    if (byPlayer) this.st.score += scoreFor(e.type, e.r);
    const big = e.type === ET.enemy || e.r > 2;
    this.boomFx(e.p, big);
    if (!this.solo) this.app.sendGame('boom', { p: e.p.map(r2), big });
  }

  applyHit(id, dmg) {
    const e = this.ents.get(id);
    if (!e || this.phase !== 'play') return;
    e.hp -= dmg;
    if (e.hp <= 0) this.destroy(e, true);
  }

  gameOver() {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.app.sendGame('over', { score: this.st.score, wave: this.st.wave });
    this.onOver();
  }

  onOver() {
    for (const id of [...this.breaches.keys()]) this.removeBreach(id);
    this.app.sfx.boom(null, true);
    this.app.toast('The ship is lost…', 3);
    if (this.st.score > this.best) {
      this.best = this.st.score;
      localStorage.setItem(BEST_KEY, String(this.best));
    }
    this.refreshPanel();
  }

  // ---------- local player ----------

  updatePilot(dt) {
    const app = this.app;
    const s = this.stick;
    let ix = 0, iy = 0;
    if (this.isPilot) {
      if (s.hand < 0) {
        app.hands.forEach((h, i) => {
          if (s.hand < 0 && h.connected && h.state.squeeze.down && h.pos.distanceTo(this.knobRest) < 0.14) {
            s.hand = i;
            h.pulse(0.4, 30);
          }
        });
      }
      if (s.hand >= 0) {
        const h = app.hands[s.hand];
        if (!h.connected || !h.state.squeeze.pressed) s.hand = -1;
        else {
          ix = THREE.MathUtils.clamp((h.pos.x - STICK_BASE.x) / 0.12, -1, 1);
          iy = THREE.MathUtils.clamp(-(h.pos.z - STICK_BASE.z) / 0.12, -1, 1);
        }
      }
      const left = app.hand('left');
      if (left && left.axes.length() > 0.15) {
        ix = left.axes.x;
        iy = -left.axes.y;
      }
    }
    const k = Math.min(1, dt * 12);
    s.x += (ix - s.x) * k;
    s.y += (iy - s.y) * k;
    this.pivot.rotation.set(-s.y * 0.4, 0, -s.x * 0.4);

    if (!this.isPilot || this.phase !== 'play') return;
    const sh = this.ship;
    const a = Math.min(1, dt * 4);
    sh.vx += (ix * LAT_SPEED - sh.vx) * a;
    sh.vy += (iy * LAT_SPEED * 0.8 - sh.vy) * a;
    sh.x += sh.vx * dt;
    sh.y += sh.vy * dt;
    clampShip(sh);
    if (!this.isHost) {
      this.shipAcc += dt;
      if (this.shipAcc >= 1 / 30) {
        this.shipAcc = 0;
        app.sendGame('ship', { x: r2(sh.x), y: r2(sh.y) }, false);
      }
    }
  }

  canShoot(i) {
    if (this.phase !== 'play' || !this.app.hands[i].connected) return false;
    return this.isGunner || (this.isPilot && this.stick.hand !== i);
  }

  updateGuns(dt) {
    this.app.hands.forEach((hand, i) => {
      const can = this.canShoot(i);
      this.guns[i].visible = can;
      hand.visual.visible = !can;
      this.cool[i] -= dt;
      if (can && hand.state.trigger.pressed && this.cool[i] <= 0 && !this.app.ui.captures(hand)) {
        this.cool[i] = this.isGunner ? 0.16 : 0.35;
        this.shoot(hand, this.isGunner ? 2 : 1);
      }
    });
  }

  shoot(hand, dmg) {
    const o = hand.rayOrigin.clone();
    o.x += this.shipView.x;
    o.y += this.shipView.y;
    const d = hand.dir.clone();
    const oa = o.toArray(), da = d.toArray();
    let best = null;
    let bestT = 400;
    for (const [id, v] of this.views) {
      const t = raySphere(oa, da, v.mesh.position.toArray(), v.r + 0.5);
      if (t >= 0 && t < bestT) { bestT = t; best = id; }
    }
    this.spawnBolt(o, d, bestT, this.app.myColor);
    if (best !== null) {
      this.fx.burst(o.clone().addScaledVector(d, bestT), 0xffffff, 10, 6, 0.3);
      if (this.isHost) this.applyHit(best, dmg);
      else this.app.sendGame('hit', { id: best, dmg });
    }
    if (!this.solo) this.app.sendGame('bolt', { o: oa.map(r2), d: da.map((c) => Math.round(c * 1000) / 1000), len: r2(bestT) });
    this.app.sfx.laser(hand.rayOrigin);
    hand.pulse(0.25, 20);
  }

  spawnBolt(o, d, len, color) {
    let b = this.bolts.find((x) => !x.mesh.visible);
    if (!b) {
      b = { mesh: new THREE.Mesh(this.boltGeo, glowMat(color)), o: new THREE.Vector3(), d: new THREE.Vector3(), t: 0, len: 0 };
      this.space.add(b.mesh);
      this.bolts.push(b);
    }
    b.mesh.material.color.set(color);
    b.o.copy(o);
    b.d.copy(d);
    b.t = 0;
    b.len = len;
    b.mesh.quaternion.setFromUnitVectors(_up, d);
    b.mesh.visible = true;
  }

  updateBolts(dt) {
    for (const b of this.bolts) {
      if (!b.mesh.visible) continue;
      b.t += BOLT_SPEED * dt;
      if (b.t > b.len) { b.mesh.visible = false; continue; }
      b.mesh.position.copy(b.o).addScaledVector(b.d, b.t + 1.25);
    }
  }

  updateRepairs(dt) {
    this.sparkAcc -= dt;
    const spark = this.sparkAcc <= 0;
    if (spark) this.sparkAcc = 0.12;
    for (const [id, b] of [...this.breaches]) {
      let active = false;
      for (const h of this.app.hands) {
        if (h.connected && h.state.squeeze.pressed && h.pos.distanceTo(b.pos) < 0.3) {
          active = true;
          h.pulse(0.15, 16);
        }
      }
      let prog = this.repair.get(id) || 0;
      prog = active ? prog + dt : Math.max(0, prog - dt * 0.5);
      this.repair.set(id, prog);
      b.ring.geometry.dispose();
      b.ring.geometry = new THREE.RingGeometry(0.17, 0.2, 32, 1, 0, Math.max(0.001, (prog / REPAIR_TIME) * Math.PI * 2));
      b.plate.material.color.setHSL(0.02, 1, 0.3 + 0.2 * Math.sin(this.app.time * 12));
      if (spark) this.app.particles.burst(b.pos, 0xffaa33, 3, 1.5, 0.4, 4);
      if (prog >= REPAIR_TIME) {
        this.app.sfx.powerup();
        if (this.isHost) {
          this.st.score += 20;
          this.removeBreach(id);
        } else {
          this.app.sendGame('repair', { id });
          this.repairedIds.add(id);
          this.removeBreach(id);
        }
      }
    }
  }

  // ---------- networking ----------

  onNet(k, d) {
    switch (k) {
      case 'join':
        if (this.isHost) this.app.sendGame('roles', { roles: this.roles, phase: this.phase });
        break;
      case 'roles':
        if (this.isHost) return;
        this.roles = d.roles;
        this.placeRig();
        this.refreshPanel();
        break;
      case 'swap':
        if (this.isHost) this.swapRoles();
        break;
      case 'launch':
        if (this.isHost) this.startRun();
        break;
      case 'start':
        if (this.isHost) return;
        for (const id of [...this.views.keys()]) this.removeView(id);
        for (const id of [...this.breaches.keys()]) this.removeBreach(id);
        this.buf.clear();
        this.shipBuf.clear();
        this.roles = d.roles;
        this.phase = 'play';
        this.placeRig();
        this.onStart();
        break;
      case 'snap':
        if (this.isHost) return;
        this.clock.update(d.ts, performance.now());
        this.buf.push(d.ts, d.e);
        if (d.sh) this.shipBuf.push(d.ts, d.sh);
        [this.st.shield, this.st.hull, this.st.score, this.st.wave, this.st.speed] = d.st;
        this.syncBreaches(d.br);
        break;
      case 'ship':
        if (this.isHost) this.remoteShip = d;
        break;
      case 'hit':
        if (this.isHost) this.applyHit(d.id, d.dmg);
        break;
      case 'repair':
        if (this.isHost && this.breaches.has(d.id)) {
          this.st.score += 20;
          this.removeBreach(d.id);
        }
        break;
      case 'bolt':
        this.spawnBolt(new THREE.Vector3(...d.o), new THREE.Vector3(...d.d), d.len, this.app.partnerColor);
        this.app.sfx.laser(_o.set(d.o[0] - this.shipView.x, d.o[1] - this.shipView.y, d.o[2]));
        break;
      case 'boom':
        this.boomFx(d.p, d.big);
        break;
      case 'hurt':
        this.onHurt(d.hull);
        break;
      case 'msg':
        this.app.toast(d.text, 3);
        if (d.text.startsWith('HULL')) this.app.sfx.alarm();
        break;
      case 'over':
        if (this.isHost) return;
        this.phase = 'over';
        this.st.score = d.score;
        this.st.wave = d.wave;
        this.onOver();
        break;
      default:
    }
  }

  syncBreaches(list) {
    const ids = new Set(list.map(([id]) => id));
    for (const [id, spot] of list) {
      if (!this.breaches.has(id) && !this.repairedIds.has(id)) this.makeBreach(id, spot);
    }
    for (const id of [...this.breaches.keys()]) if (!ids.has(id)) this.removeBreach(id);
    for (const id of [...this.repairedIds]) if (!ids.has(id)) this.repairedIds.delete(id);
  }

  sendSnapshot(dt) {
    if (this.solo || !this.isHost || this.phase !== 'play') return;
    this.sendAcc += dt;
    if (this.sendAcc < 1 / 20) return;
    this.sendAcc = 0;
    const e = [];
    for (const x of this.ents.values()) e.push([x.id, x.type, r2(x.p[0]), r2(x.p[1]), r2(x.p[2]), r2(x.r)]);
    this.app.sendGame('snap', {
      ts: performance.now(),
      sh: this.isPilot ? [r2(this.ship.x), r2(this.ship.y)] : null,
      st: [Math.round(this.st.shield), Math.round(this.st.hull), this.st.score, this.st.wave, this.st.speed],
      e,
      br: [...this.breaches.values()].map((b) => [b.id, b.spot]),
    }, false);
  }

  // ---------- per-frame ----------

  boomFx(p, big) {
    this.fx.burst(p, big ? 0xffaa33 : 0xffddaa, big ? 70 : 30, big ? 14 : 8, big ? 1.2 : 0.7);
    this.app.sfx.boom(_o.set(p[0] - this.shipView.x, p[1] - this.shipView.y, p[2]), big);
  }

  update(dt, t) {
    this.updatePilot(dt);

    // Where the ship is, as far as this player knows.
    if (this.isPilot) {
      this.shipView.x = this.ship.x;
      this.shipView.y = this.ship.y;
    } else if (this.isHost) {
      const a = Math.min(1, dt * 15);
      this.shipView.x += (this.remoteShip.x - this.shipView.x) * a;
      this.shipView.y += (this.remoteShip.y - this.shipView.y) * a;
    } else if (this.shipBuf.size) {
      const s = this.shipBuf.sample(this.clock.remoteNow(performance.now()) - INTERP_DELAY_MS);
      this.shipView.x = s[0];
      this.shipView.y = s[1];
    }
    this.space.position.set(-this.shipView.x, -this.shipView.y, 0);

    if (this.isHost && this.phase === 'play') this.hostSim(dt);
    this.sendSnapshot(dt);
    this.syncViews(t);
    this.updateGuns(dt);
    this.updateBolts(dt);
    if (this.phase === 'play') this.updateRepairs(dt);
    this.fx.update(dt);
    this.updateStars(dt);

    this.hurt = Math.max(0, this.hurt - dt * 1.5);
    this.hurtMesh.material.opacity = this.hurt * 0.5;
    this.hurtMesh.visible = this.hurt > 0;

    this.hudAcc -= dt;
    if (this.hudAcc <= 0) {
      this.hudAcc = 0.25;
      const st = this.st;
      this.hudCenter.set(this.phase === 'brief' ? 'READY FOR LAUNCH' : `WAVE ${st.wave}  ·  ${st.score} PTS`);
      const shipText = `SHIELD ${Math.round(st.shield)}%\nHULL ${Math.round(st.hull)}%`;
      const color = st.hull < 30 ? '#ff6b6b' : st.shield < 30 ? '#ffb347' : '#7dffef';
      this.hudLeft.set(shipText, color);
      this.hudRight.set(this.breaches.size ? `BREACHES: ${this.breaches.size}\nFIX THEM!` : shipText, this.breaches.size ? '#ff6b6b' : color);
    }
  }

  syncViews(t) {
    let source;
    if (this.isHost) {
      source = new Map();
      for (const e of this.ents.values()) source.set(e.id, [e.type, e.p[0], e.p[1], e.p[2], e.r]);
    } else {
      source = this.buf.size ? this.buf.sample(this.clock.remoteNow(performance.now()) - INTERP_DELAY_MS) : new Map();
    }
    for (const [id, v] of source) {
      const view = this.views.get(id) || this.makeView(id, v[0], v[4]);
      view.mesh.position.set(v[1], v[2], v[3]);
      if (view.type === ET.asteroid) view.mesh.rotation.set(t * view.spin, t * view.spin * 0.7, 0);
      else if (view.type === ET.enemy) view.mesh.rotation.z = Math.sin(t * 2 + id) * 0.3;
      else view.mesh.scale.setScalar(1 + Math.sin(t * 20 + id) * 0.2);
    }
    for (const id of [...this.views.keys()]) if (!source.has(id)) this.removeView(id);
  }

  updateStars(dt) {
    const V = this.phase === 'play' ? this.st.speed : 8;
    const len = Math.max(0.3, V * 0.06);
    const s = this.star;
    const out = this.streakPos;
    for (let i = 0; i < STARS; i++) {
      const j = i * 3;
      s[j + 2] += V * dt;
      if (s[j + 2] > 20) {
        s[j + 2] -= 320;
        s[j] = this.shipView.x + rand(-70, 70);
        s[j + 1] = this.shipView.y + rand(-45, 45);
      }
      const o = i * 6;
      out[o] = s[j]; out[o + 1] = s[j + 1]; out[o + 2] = s[j + 2];
      out[o + 3] = s[j]; out[o + 4] = s[j + 1]; out[o + 5] = s[j + 2] - len;
    }
    this.streakAttr.needsUpdate = true;
  }

  dispose() {
    for (const h of this.app.hands) h.visual.visible = true;
    super.dispose();
  }
}
