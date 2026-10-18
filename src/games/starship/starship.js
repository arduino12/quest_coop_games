import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { Particles, edges, glowMat, lineMat, starfield } from '../../core/env.js';
import { EntityBuffer, SnapshotBuffer, ClockSync, r2, r4 } from '../../core/sync.js';
import { INTERP_DELAY_MS } from '../../config.js';
import {
  ET, HIT_R, BODY_R, SCORE, DAMAGE, SECTOR_R, SHIP_R, YAW_RATE, PITCH_RATE, PITCH_MAX, MIN_SPEED, MAX_SPEED,
  SHIELD_REGEN, REGEN_DELAY, BREACH_DRAIN, MAX_BREACHES, MINE_TRIGGER_R, MINE_BLAST_R, MINE_FUSE,
  SEEKER_RANGE, SEEKER_SPEED, BREACH_SPOTS, generateSector, shipQuat, forward, leadTarget, raySphere,
  applyDamage, mapProject, add, sub, scale, norm, dist, dot,
} from './logic.js';

const PILOT_X = -0.65;
const GUNNER_X = 0.65;
const STICK_BASE = new THREE.Vector3(PILOT_X + 0.3, 0.93, -0.45);
const STICK_LEN = 0.16;
const THROTTLE_BASE = new THREE.Vector3(PILOT_X - 0.34, 0.93, -0.42);
const THROTTLE_TRAVEL = 0.24;
const MAP_CENTER = new THREE.Vector3(0, 1.08, -0.5);
const MAP_R = 0.22;
const MAP_RANGE = 900;
const NOSE_GUNS = [new THREE.Vector3(-1.3, 0.6, -1.7), new THREE.Vector3(1.3, 0.6, -1.7)];
const BOLT_SPEED = 600;
const BOLT_RANGE = 700;
const DUST = 400;
const DUST_BOX = 140;
const MAX_MINES = 400;
const MAX_ASTEROIDS = 60;
const MAP_MINES = 300;
const REPAIR_TIME = 1.2;
const BEST_KEY = 'qcg-starship-best';
const rand = (a, b) => a + Math.random() * (b - a);
const randomUnit = () => norm([rand(-1, 1), rand(-1, 1), rand(-1, 1)]);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _fwdZ = new THREE.Vector3(0, 0, 1);

// The cockpit stays put around the players; the whole universe (`space`) is moved and rotated
// by the inverse of the ship's pose, so cockpit controls never move under the players' hands.
//
// Netcode: the pilot owns the ship pose (no steering lag). The host simulates enemies, mines,
// damage and score. Each shooter detects their own hits and reports them (co-op, so we trust them).
// The static layout comes from (level, seed), so only kills and moving things go over the network.
export class Starship extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.roles = { pilot: 'host', gunner: this.solo ? 'host' : 'guest' };
    this.phase = 'brief'; // brief -> play <-> cleared -> over
    this.level = 1;
    this.seed = 0;
    this.sector = null;

    this.ship = { p: new THREE.Vector3(), yaw: 0, pitch: 0, throttle: 0.45, speed: 25, vel: new THREE.Vector3() };
    this.view = { p: new THREE.Vector3(), q: new THREE.Quaternion(), vel: new THREE.Vector3(), prev: new THREE.Vector3() };
    this.remoteShip = { p: new THREE.Vector3(), q: new THREE.Quaternion(), v: [0, 0, 0], has: false };
    this.st = { shield: 100, hull: 100, score: 0, level: 1, obj: -1, objHp: 1 };

    this.statics = new Map(); // outposts, turrets, mines: id -> state (both players)
    this.dyn = new Map(); // host: fighters & plasma being simulated
    this.dynView = new Map(); // what is drawn: id -> { type, p, mesh }
    this.staticViews = new Map(); // outpost/turret id -> mesh
    this.mineIndex = new Map(); // mine id -> instance index
    this.armed = new Set();
    this.buf = new EntityBuffer();
    this.shipBuf = new SnapshotBuffer({ stride: 7, quatOffset: 3 });
    this.clock = new ClockSync();

    this.breaches = new Map();
    this.repair = new Map();
    this.repairedIds = new Set();
    this.cool = [0, 0];
    this.noseCool = 0;
    this.noseSide = 0;
    this.lastDamage = -99;
    this.bumpCool = 0;
    this.nextDyn = 10000;
    this.nextBreach = 1;
    this.stick = { hand: -1, x: 0, y: 0 };
    this.lever = { hand: -1 };
    this.sendAcc = 0;
    this.shipAcc = 0;
    this.hudAcc = 0;
    this.sparkAcc = 0;
    this.edgeWarn = 0;
    this.clearT = 0;
    this.hurt = 0;
    this.best = Number(localStorage.getItem(BEST_KEY) || 0);

    this.sky = new THREE.Group();
    this.space = new THREE.Group();
    this.root.add(this.sky, this.space);
    this.fx = new Particles(this.space, { max: 900, size: 1.2 });
    this.bolts = [];
    app.camera.far = 5000;
    app.camera.updateProjectionMatrix();

    this.makeAssets();
    this.buildSky();
    this.buildCockpit();
    this.buildControls();
    this.buildGuns();
    this.buildMap();
    this.buildHud();
    this.buildMarker();
    this.buildDust();
    this.placeRig();
    this.refreshPanel();
    if (!this.isHost) app.sendGame('join');
  }

  get isPilot() { return this.roles.pilot === this.mySide; }
  get isGunner() { return this.roles.gunner === this.mySide; }
  get cfg() { return this.sector.cfg; }

  // ---------- setup ----------

  makeAssets() {
    this.mats = {
      hull: new THREE.MeshLambertMaterial({ color: 0x3a3550, flatShading: true }),
      dark: new THREE.MeshLambertMaterial({ color: 0x2a2030, flatShading: true }),
      red: glowMat(0xff2244),
      plasma: glowMat(0xff3355),
      halo: new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    };
    this.geos = {
      core: new THREE.SphereGeometry(10, 20, 14),
      ring: new THREE.TorusGeometry(16, 1.2, 8, 40),
      spike: new THREE.CylinderGeometry(0.8, 0.8, 34, 6),
      beacon: new THREE.SphereGeometry(3, 12, 8),
      turret: new THREE.BoxGeometry(2.6, 2.6, 2.6),
      barrel: new THREE.CylinderGeometry(0.4, 0.4, 3, 8),
      fBody: new THREE.ConeGeometry(0.9, 3.2, 6),
      fWing: new THREE.BoxGeometry(4.2, 0.15, 1.1),
      fEye: new THREE.SphereGeometry(0.4, 10, 8),
      plasma: new THREE.SphereGeometry(0.6, 10, 8),
      plasmaHalo: new THREE.SphereGeometry(1.3, 10, 8),
      bolt: new THREE.CylinderGeometry(0.06, 0.06, 5, 6),
    };

    this.mines = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1.6, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_MINES);
    this.mines.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mines.frustumCulled = false;
    for (let i = 0; i < MAX_MINES; i++) this.mines.setColorAt(i, _c.set(0xff8800));
    this.mines.count = 0; // no sector loaded yet
    this.space.add(this.mines);

    this.rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: 0x8a7a6a, flatShading: true }), MAX_ASTEROIDS);
    this.rocks.count = 0;
    this.rocks.frustumCulled = false;
    this.space.add(this.rocks);
  }

  makeOutpost() {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(this.geos.core, this.mats.hull));
    const ring = new THREE.Mesh(this.geos.ring, this.mats.red);
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
    for (const rz of [0, Math.PI / 2]) {
      const sp = new THREE.Mesh(this.geos.spike, this.mats.dark);
      sp.rotation.z = rz;
      g.add(sp);
    }
    const beacon = new THREE.Mesh(this.geos.beacon, this.mats.halo);
    beacon.position.y = 14;
    g.add(beacon);
    g.userData.beacon = beacon;
    return g;
  }

  makeTurret() {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(this.geos.turret, this.mats.dark));
    const barrel = new THREE.Mesh(this.geos.barrel, this.mats.red);
    barrel.position.y = 2;
    g.add(barrel);
    return g;
  }

  makeFighter() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.geos.fBody, this.mats.dark);
    body.rotation.x = Math.PI / 2; // nose toward +z (we orient +z along the flight direction)
    const wing = new THREE.Mesh(this.geos.fWing, this.mats.dark);
    const eye = new THREE.Mesh(this.geos.fEye, this.mats.red);
    eye.position.z = 1.2;
    g.add(body, wing, eye, edges(this.geos.fWing, 0xff2244));
    return g;
  }

  makePlasma() {
    const g = new THREE.Mesh(this.geos.plasma, this.mats.plasma);
    g.add(new THREE.Mesh(this.geos.plasmaHalo, this.mats.halo));
    return g;
  }

  buildSky() {
    const app = this.app;
    app.scene.background = new THREE.Color(0x020310);
    this.root.add(new THREE.HemisphereLight(0xaab8ff, 0x221a33, 0.9));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.7);
    sun.position.set(-4, 6, 3);
    this.sky.add(sun);
    this.sky.add(starfield(2000, 2500, 3500));
    const planet = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 24), new THREE.MeshLambertMaterial({ color: 0x4b2f9a }));
    planet.position.set(-1500, -700, -3000);
    this.sky.add(planet);
    const ring = new THREE.Mesh(new THREE.RingGeometry(580, 780, 64), new THREE.MeshBasicMaterial({
      color: 0x8f7fff, side: THREE.DoubleSide, transparent: true, opacity: 0.35,
    }));
    ring.position.copy(planet.position);
    ring.rotation.set(1.2, 0.3, 0);
    this.sky.add(ring);
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

    for (const s of BREACH_SPOTS) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({ color: 0x2a3350 }));
      panel.position.set(...s);
      panel.lookAt(0, 1.1, 0.3);
      root.add(panel);
    }

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
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), glowMat(0x7dff8a));
    knob.position.y = STICK_LEN;
    this.pivot.add(shaft, knob);
    this.root.add(this.pivot);
    this.knobRest = STICK_BASE.clone().add(new THREE.Vector3(0, STICK_LEN, 0));

    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, THROTTLE_TRAVEL + 0.06), metal);
    rail.position.copy(THROTTLE_BASE);
    this.root.add(rail);
    this.leverHandle = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.1, 8), metal);
    post.position.y = 0.05;
    const grip = new THREE.Mesh(new THREE.SphereGeometry(0.033, 16, 12), glowMat(0xffb347));
    grip.position.y = 0.1;
    this.leverHandle.add(post, grip);
    this.root.add(this.leverHandle);
    const tag = new Label('THROTTLE', { w: 0.2, h: 0.04, color: '#ffb347' });
    tag.mesh.position.set(THROTTLE_BASE.x, THROTTLE_BASE.y + 0.02, THROTTLE_BASE.z + 0.18);
    tag.mesh.rotation.x = -Math.PI / 2;
    this.root.add(tag.mesh);
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
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -0.1), new THREE.Vector3(0, 0, -40)]),
        lineMat(this.app.myColor, 0.25),
      );
      g.add(body, barrel, aim);
      g.visible = false;
      return this.attach(hand.ray, g);
    });
  }

  buildMap() {
    const g = (this.map = new THREE.Group());
    g.position.copy(MAP_CENTER);
    this.root.add(g);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(MAP_R, 48), new THREE.MeshBasicMaterial({
      color: 0x22e6ff, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
    }));
    disc.rotation.x = -Math.PI / 2;
    g.add(disc);
    for (const f of [1 / 3, 2 / 3, 1]) {
      const pts = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * MAP_R * f, 0, Math.sin(a) * MAP_R * f));
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(0x22e6ff, f === 1 ? 0.8 : 0.3)));
    }
    const me = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.035, 8), glowMat(0x7dff8a));
    me.rotation.x = -Math.PI / 2;
    g.add(me);
    const range = new Label(`${MAP_RANGE} m`, { w: 0.12, h: 0.03, color: '#22e6ff' });
    range.mesh.position.set(MAP_R * 0.75, 0.005, MAP_R * 0.75);
    range.mesh.rotation.x = -Math.PI / 2;
    g.add(range.mesh);

    this.mapIcons = { outposts: [], fighters: [] };
    this.mapOutGeo = new THREE.OctahedronGeometry(0.014, 0);
    this.mapOutMat = glowMat(0xff4466);
    this.mapObjMat = glowMat(0xffee33);
    this.mapFighterGeo = new THREE.ConeGeometry(0.006, 0.018, 5);
    this.mapFighterMat = glowMat(0xff2244);
    this.mapMinePos = new Float32Array(MAP_MINES * 3);
    const mg = new THREE.BufferGeometry();
    this.mapMineAttr = new THREE.BufferAttribute(this.mapMinePos, 3);
    mg.setAttribute('position', this.mapMineAttr);
    this.mapMines = new THREE.Points(mg, new THREE.PointsMaterial({ color: 0xff8800, size: 0.006 }));
    this.mapMines.frustumCulled = false;
    g.add(this.mapMines);

    // 3D arrow above the map pointing at the current target.
    this.arrow = new THREE.Group();
    this.arrow.position.set(0, 0.17, 0);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 8), glowMat(0xffee33));
    shaft.position.y = -0.02;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.05, 12), glowMat(0xffee33));
    tip.position.y = 0.035;
    this.arrow.add(shaft, tip);
    g.add(this.arrow);
  }

  buildHud() {
    const screen = (x, w) => {
      const l = new Label('', { w, h: 0.2, res: 512, size: 0.75, bg: 'rgba(0,20,30,0.85)', color: '#7dffef' });
      l.mesh.position.set(x, 1.04, -0.93);
      l.mesh.rotation.x = -0.3;
      this.root.add(l.mesh);
      return l;
    };
    this.hudCenter = screen(0, 0.62);
    this.hudLeft = screen(-0.95, 0.5);
    this.hudRight = screen(0.95, 0.5);
    this.panel = this.app.ui.add(new Panel({ w: 1.4, h: 1.05, accent: '#7dff8a' }));
    this.panel.mesh.position.set(0, 1.62, -0.95);
    this.root.add(this.panel.mesh);

    // Messages go on a banner along the top of the windshield, never across the view.
    this.banner = new Label('', { w: 1.9, h: 0.24, res: 1024, size: 0.4, bg: 'rgba(5,8,20,0.85)', color: '#ffee33' });
    this.banner.mesh.position.set(0, 2.3, -1.0);
    this.banner.mesh.rotation.x = 0.35; // tilted down toward the crew
    this.banner.mesh.visible = false;
    this.bannerT = 0;
    this.root.add(this.banner.mesh);
  }

  onToast(text, seconds) {
    this.banner.set(text.replace(/\n/g, '  ·  '));
    this.banner.mesh.visible = true;
    this.bannerT = seconds;
    this.app.sfx.tone({ f: 1046, dur: 0.08, type: 'triangle', vol: 0.1 });
    return true;
  }

  buildMarker() {
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), new THREE.MeshBasicMaterial({
      color: 0xffee33, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide,
    }));
    this.marker.renderOrder = 997;
    this.marker.visible = false;
    this.space.add(this.marker);
    this.markerLabel = new Label('', { w: 2, h: 0.4, color: '#ffee33', size: 0.7 });
    this.markerLabel.mesh.material.depthTest = false;
    this.markerLabel.mesh.renderOrder = 997;
    this.markerLabel.mesh.visible = false;
    this.space.add(this.markerLabel.mesh);
  }

  buildDust() {
    this.dustBase = new Float32Array(DUST * 3);
    for (let i = 0; i < DUST * 3; i++) this.dustBase[i] = rand(0, DUST_BOX);
    this.dustPos = new Float32Array(DUST * 6);
    const g = new THREE.BufferGeometry();
    this.dustAttr = new THREE.BufferAttribute(this.dustPos, 3);
    g.setAttribute('position', this.dustAttr);
    this.dust = new THREE.LineSegments(g, lineMat(0xbfd0ff, 0.6));
    this.dust.frustumCulled = false;
    this.space.add(this.dust);
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
          `You are the ${you}. Mission: find and destroy every enemy outpost. The map in front of you shows targets (yellow), outposts, fighters and mines.`,
          'Pilot: joystick or left thumbstick steers all around; throttle lever or right thumbstick sets speed; joystick trigger fires the nose guns.',
          'Gunner: aim with your hands and pull the triggers. Shoot mines before you fly into them!',
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
        lines: [`You reached level ${this.st.level} with ${this.st.score} points.`, `Best: ${Math.max(this.best, this.st.score)}`],
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

  // ---------- sector ----------

  loadSector(level, seed) {
    for (const id of [...this.dynView.keys()]) this.removeDynView(id);
    for (const mesh of this.staticViews.values()) this.space.remove(mesh);
    this.staticViews.clear();
    this.statics.clear();
    this.mineIndex.clear();
    this.dyn.clear();
    this.armed.clear();
    this.buf.clear();
    this.level = level;
    this.seed = seed;
    this.sector = generateSector(level, seed);
    const s = this.sector;
    for (const o of [...s.outposts, ...s.turrets]) {
      this.statics.set(o.id, { ...o, p: o.p.slice(), alive: true });
      const mesh = o.type === ET.outpost ? this.makeOutpost() : this.makeTurret();
      mesh.position.set(...o.p);
      this.space.add(mesh);
      this.staticViews.set(o.id, mesh);
    }
    s.mines.slice(0, MAX_MINES).forEach((m, i) => {
      this.statics.set(m.id, { ...m, p: m.p.slice(), alive: true, fuse: null });
      this.mineIndex.set(m.id, i);
    });
    this.rocks.count = Math.min(s.asteroids.length, MAX_ASTEROIDS);
    for (let i = 0; i < this.rocks.count; i++) {
      const a = s.asteroids[i];
      _q.setFromEuler(new THREE.Euler(i, i * 2.3, i * 0.7));
      this.rocks.setMatrixAt(i, _m.compose(_v.set(...a.p), _q, _s.set(a.r, a.r * 0.8, a.r * 1.1)));
    }
    this.rocks.instanceMatrix.needsUpdate = true;
    this.st.level = level;
    this.st.obj = s.outposts[0].id;
    this.st.objHp = 1;
    if (this.isPilot) {
      this.ship.p.set(0, 0, 0);
      this.ship.yaw = 0;
      this.ship.pitch = 0;
      this.ship.throttle = 0.45;
    }
  }

  outpostsLeft() {
    let n = 0;
    for (const e of this.statics.values()) if (e.type === ET.outpost && e.alive) n++;
    return n;
  }

  // ---------- host simulation ----------

  startRun() {
    if (this.phase === 'play') return;
    for (const id of [...this.breaches.keys()]) this.removeBreach(id);
    this.st = { shield: 100, hull: 100, score: 0, level: 1, obj: -1, objHp: 1 };
    this.seed = Math.floor(Math.random() * 1e9);
    this.loadSector(1, this.seed);
    this.spawnInitialFighters();
    this.phase = 'play';
    this.app.sendGame('start', { roles: this.roles, level: 1, seed: this.seed });
    this.onStart();
    this.announce(`LEVEL 1: destroy ${this.cfg.outposts} enemy outposts.\nFollow the yellow arrow!`);
  }

  onStart() {
    this.refreshPanel();
    this.app.sfx.powerup();
  }

  spawnInitialFighters() {
    const outs = this.sector.outposts;
    for (let i = 0; i < this.cfg.fighters; i++) this.spawnFighter(outs[i % outs.length].p);
  }

  spawnFighter(home) {
    const id = this.nextDyn++;
    this.dyn.set(id, {
      id, type: ET.fighter, p: add(home, scale(randomUnit(), 40)), dir: randomUnit(), hp: this.cfg.fighterHp,
      state: 'patrol', home: home.slice(), ph: rand(0, 6), fireT: rand(0.5, 2) * this.cfg.fireEvery, breakT: 0, breakDir: null, t: 0,
    });
  }

  firePlasma(from, ship, shipVel, accuracyScale = 1) {
    const cfg = this.cfg;
    const aim = add(leadTarget(from, ship, shipVel, cfg.plasmaSpeed), scale(randomUnit(), cfg.spread * accuracyScale * Math.random()));
    const id = this.nextDyn++;
    this.dyn.set(id, { id, type: ET.plasma, p: from.slice(), v: scale(norm(sub(aim, from)), cfg.plasmaSpeed), hp: 1, t: 0 });
    if (dist(from, ship) < 250) this.app.sfx.laser(this.toCockpit(from));
  }

  fighterAI(f, dt, ship, shipVel) {
    const cfg = this.cfg;
    f.t += dt;
    const toShip = sub(ship, f.p);
    const d = Math.hypot(...toShip);
    let desired;
    if (f.state === 'patrol') {
      const orbit = [f.home[0] + Math.cos(f.t * 0.3 + f.ph) * 90, f.home[1] + Math.sin(f.t * 0.2) * 30, f.home[2] + Math.sin(f.t * 0.3 + f.ph) * 90];
      desired = sub(orbit, f.p);
      if (d < 480) f.state = 'attack';
    } else {
      if (f.breakT > 0) {
        f.breakT -= dt;
        desired = f.breakDir;
      } else {
        desired = sub(leadTarget(f.p, ship, shipVel, cfg.fighterSpeed), f.p);
        if (d < 60) {
          f.breakT = 2.2;
          f.breakDir = norm(add(randomUnit(), scale(norm(toShip), -0.5)));
        }
      }
      if (d > 950) f.state = 'patrol';
      f.fireT -= dt;
      if (f.fireT <= 0 && d < 380 && dot(f.dir, norm(toShip)) > 0.9) {
        f.fireT = cfg.fireEvery * rand(0.8, 1.2);
        this.firePlasma(f.p, ship, shipVel);
      }
    }
    const want = norm(desired);
    const k = Math.min(1, 1.8 * dt);
    f.dir = norm(add(scale(f.dir, 1 - k), scale(want, k)));
    f.p = add(f.p, scale(f.dir, cfg.fighterSpeed * dt));
  }

  hostSim(dt) {
    const cfg = this.cfg;
    const ship = this.view.p.toArray();
    const shipVel = this.isPilot ? this.ship.vel.toArray() : this.remoteShip.v;
    let fighters = 0;
    for (const e of this.dyn.values()) if (e.type === ET.fighter) fighters++;

    for (const e of this.statics.values()) {
      if (!e.alive) continue;
      if (e.type === ET.outpost) {
        e.spawnT = (e.spawnT ?? cfg.spawnEvery * Math.random()) - dt;
        if (e.spawnT <= 0) {
          e.spawnT = cfg.spawnEvery;
          if (fighters < cfg.fighterCap) { this.spawnFighter(e.p); fighters++; }
        }
      } else if (e.type === ET.turret) {
        if (dist(e.p, ship) < 420) {
          e.fireT = (e.fireT ?? rand(0, 2)) - dt;
          if (e.fireT <= 0) {
            e.fireT = cfg.fireEvery * 1.4 * rand(0.8, 1.2);
            this.firePlasma(e.p, ship, shipVel, 1.3);
          }
        }
      } else if (e.type === ET.mine) {
        const d = dist(e.p, ship);
        if (e.seeker && e.fuse === null && d < SEEKER_RANGE) {
          e.p = add(e.p, scale(norm(sub(ship, e.p)), SEEKER_SPEED * dt));
          e.moving = true;
        }
        if (e.fuse === null && d < MINE_TRIGGER_R) {
          e.fuse = MINE_FUSE;
          this.armed.add(e.id);
          this.app.sfx.alarm();
        }
        if (e.fuse !== null) {
          e.fuse -= dt;
          if (e.fuse <= 0) {
            if (d < MINE_BLAST_R) this.damage(DAMAGE.mine);
            this.killStatic(e, false);
          }
        }
      }
    }

    for (const e of [...this.dyn.values()]) {
      if (e.type === ET.fighter) this.fighterAI(e, dt, ship, shipVel);
      else {
        e.t += dt;
        e.p = add(e.p, scale(e.v, dt));
        if (e.t > 6) this.dyn.delete(e.id);
        else if (dist(e.p, ship) < SHIP_R + 0.8) {
          this.dyn.delete(e.id);
          this.damage(DAMAGE.plasma);
        }
      }
    }

    this.bumpCool -= dt;
    if (this.bumpCool <= 0 && this.touchingObstacle(ship)) {
      this.bumpCool = 1;
      this.damage(DAMAGE.bump);
    }

    if (this.app.time - this.lastDamage > REGEN_DELAY) this.st.shield = Math.min(100, this.st.shield + SHIELD_REGEN * dt);
    this.st.hull = Math.max(0, this.st.hull - BREACH_DRAIN * this.breaches.size * dt);
    if (this.st.hull <= 0) this.gameOver();

    const obj = this.statics.get(this.st.obj);
    if (!obj || !obj.alive) {
      let best = null;
      for (const e of this.statics.values()) {
        if (e.type === ET.outpost && e.alive && (!best || dist(e.p, ship) < dist(best.p, ship))) best = e;
      }
      if (best) this.st.obj = best.id;
      else if (this.phase === 'play') this.levelCleared();
    }
    const cur = this.statics.get(this.st.obj);
    this.st.objHp = cur ? Math.max(0, cur.hp / this.cfg.coreHp) : 0;
  }

  touchingObstacle(ship) {
    for (const a of this.sector.asteroids) if (dist(a.p, ship) < a.r + SHIP_R) return a;
    for (const e of this.statics.values()) {
      if (e.type === ET.outpost && e.alive && dist(e.p, ship) < BODY_R.outpost + SHIP_R) return e;
    }
    return null;
  }

  levelCleared() {
    this.phase = 'cleared';
    this.clearT = 6;
    this.st.score += 1000;
    this.announce(`SECTOR CLEARED! +1000\nWarping to level ${this.level + 1}…`);
    this.app.sendGame('phase', { phase: 'cleared' });
    this.app.sfx.powerup();
  }

  nextLevel() {
    const level = this.level + 1;
    this.seed = Math.floor(Math.random() * 1e9);
    for (const id of [...this.breaches.keys()]) this.removeBreach(id);
    this.loadSector(level, this.seed);
    this.st.hull = Math.min(100, this.st.hull + 30);
    this.st.shield = 100;
    this.spawnInitialFighters();
    this.phase = 'play';
    this.app.sendGame('level', { level, seed: this.seed });
    this.announce(`LEVEL ${level}: destroy ${this.cfg.outposts} outposts`);
  }

  damage(dmg) {
    const toHull = applyDamage(this.st, dmg);
    this.lastDamage = this.app.time;
    this.onHurt(toHull > 0);
    if (!this.solo) this.app.sendGame('hurt', { hull: toHull > 0 });
    if (toHull > 0 && this.breaches.size < MAX_BREACHES && Math.random() < 0.45) this.addBreach();
  }

  onHurt(hull) {
    this.hurt = hull ? 0.6 : 0.25;
    this.app.sfx.boom(null, false);
    for (const h of this.app.hands) h.pulse(hull ? 1 : 0.5, 120);
  }

  killStatic(e, byPlayer) {
    if (!e.alive) return;
    e.alive = false;
    this.armed.delete(e.id);
    if (byPlayer) this.st.score += SCORE[e.type];
    const big = e.type === ET.outpost;
    this.onKillStatic(e.id, big);
    if (!this.solo) this.app.sendGame('kill', { id: e.id, big, p: e.p.map(r2) });
    if (e.type === ET.outpost) {
      for (const t of this.statics.values()) if (t.type === ET.turret && t.owner === e.id) this.killStatic(t, false);
      const left = this.outpostsLeft();
      if (left) this.announce(`Outpost destroyed! ${left} to go`);
    }
  }

  onKillStatic(id, big, p = null) {
    const e = this.statics.get(id);
    if (e) {
      e.alive = false;
      if (p) e.p = p;
    }
    const mesh = this.staticViews.get(id);
    if (mesh) mesh.visible = false;
    const pos = e ? e.p : p;
    if (pos) this.boomFx(pos, big || e?.type === ET.turret);
  }

  killDyn(e, byPlayer) {
    this.dyn.delete(e.id);
    if (byPlayer) this.st.score += SCORE[e.type];
    const big = e.type === ET.fighter;
    this.boomFx(e.p, big);
    if (!this.solo) this.app.sendGame('boom', { p: e.p.map(r2), big });
  }

  applyHit(id, dmg) {
    if (this.phase !== 'play') return;
    const s = this.statics.get(id);
    if (s && s.alive) {
      s.hp -= dmg;
      if (s.hp <= 0) this.killStatic(s, true);
      return;
    }
    const d = this.dyn.get(id);
    if (d) {
      d.hp -= dmg;
      if (d.hp <= 0) this.killDyn(d, true);
    }
  }

  gameOver() {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.app.sendGame('over', { score: this.st.score, level: this.st.level });
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

  announce(text) {
    this.app.toast(text, 3.5);
    this.app.sendGame('msg', { text });
  }

  // ---------- breaches ----------

  addBreach() {
    const used = new Set([...this.breaches.values()].map((b) => b.spot));
    const free = BREACH_SPOTS.map((_, i) => i).filter((i) => !used.has(i));
    if (!free.length) return;
    this.makeBreach(this.nextBreach++, free[Math.floor(Math.random() * free.length)]);
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
        if (this.isHost) this.st.score += 20;
        else {
          this.app.sendGame('repair', { id });
          this.repairedIds.add(id);
        }
        this.removeBreach(id);
      }
    }
  }

  syncBreaches(list) {
    const ids = new Set(list.map(([id]) => id));
    for (const [id, spot] of list) if (!this.breaches.has(id) && !this.repairedIds.has(id)) this.makeBreach(id, spot);
    for (const id of [...this.breaches.keys()]) if (!ids.has(id)) this.removeBreach(id);
    for (const id of [...this.repairedIds]) if (!ids.has(id)) this.repairedIds.delete(id);
  }

  // ---------- pilot ----------

  updatePilot(dt) {
    const app = this.app;
    const s = this.stick;
    const lv = this.lever;
    let ix = 0, iy = 0;
    if (this.isPilot) {
      app.hands.forEach((h, i) => {
        if (!h.connected || !h.state.squeeze.down) return;
        if (s.hand < 0 && lv.hand !== i && h.pos.distanceTo(this.knobRest) < 0.14) { s.hand = i; h.pulse(0.4, 30); }
        else if (lv.hand < 0 && s.hand !== i && h.pos.distanceTo(this.leverHandle.position) < 0.16) { lv.hand = i; h.pulse(0.4, 30); }
      });
      if (s.hand >= 0) {
        const h = app.hands[s.hand];
        if (!h.connected || !h.state.squeeze.pressed) s.hand = -1;
        else {
          ix = THREE.MathUtils.clamp((h.pos.x - STICK_BASE.x) / 0.12, -1, 1);
          iy = THREE.MathUtils.clamp(-(h.pos.z - STICK_BASE.z) / 0.12, -1, 1);
        }
      }
      if (lv.hand >= 0) {
        const h = app.hands[lv.hand];
        if (!h.connected || !h.state.squeeze.pressed) lv.hand = -1;
        else this.ship.throttle = THREE.MathUtils.clamp(0.5 - (h.pos.z - THROTTLE_BASE.z) / THROTTLE_TRAVEL, 0, 1);
      }
      const left = app.hand('left');
      if (left && left.axes.length() > 0.15) { ix = left.axes.x; iy = -left.axes.y; }
      const right = app.hand('right');
      if (right && Math.abs(right.axes.y) > 0.2) this.ship.throttle = THREE.MathUtils.clamp(this.ship.throttle - right.axes.y * dt * 0.6, 0, 1);
    }
    const k = Math.min(1, dt * 10);
    s.x += (ix - s.x) * k;
    s.y += (iy - s.y) * k;
    this.pivot.rotation.set(-s.y * 0.4, 0, -s.x * 0.4);
    this.leverHandle.position.set(THROTTLE_BASE.x, THROTTLE_BASE.y, THROTTLE_BASE.z - (this.ship.throttle - 0.5) * THROTTLE_TRAVEL);

    if (!this.isPilot || (this.phase !== 'play' && this.phase !== 'cleared')) return;
    const sh = this.ship;
    sh.yaw -= s.x * YAW_RATE * dt;
    sh.pitch = THREE.MathUtils.clamp(sh.pitch + s.y * PITCH_RATE * dt, -PITCH_MAX, PITCH_MAX);
    const target = MIN_SPEED + sh.throttle * (MAX_SPEED - MIN_SPEED);
    sh.speed += (target - sh.speed) * Math.min(1, dt * 1.5);
    sh.vel.set(...forward(sh.yaw, sh.pitch)).multiplyScalar(sh.speed);
    sh.p.addScaledVector(sh.vel, dt);

    // Slide off rocks and outposts instead of flying through them (the host applies the damage).
    const p = sh.p.toArray();
    const solid = this.touchingObstacle(p);
    if (solid) {
      const r = solid.r !== undefined ? solid.r : BODY_R.outpost;
      sh.p.set(...add(solid.p, scale(norm(sub(p, solid.p)), r + SHIP_R + 0.1)));
    }
    if (sh.p.length() > SECTOR_R) {
      sh.p.setLength(SECTOR_R);
      if (app.time - this.edgeWarn > 3) {
        this.edgeWarn = app.time;
        app.toast('Edge of the sector: turn back!', 2.5);
      }
    }

    if (!this.isHost) {
      this.shipAcc += dt;
      if (this.shipAcc >= 1 / 30) {
        this.shipAcc = 0;
        const q = shipQuat(sh.yaw, sh.pitch);
        app.sendGame('ship', { p: sh.p.toArray().map(r2), q: q.map(r4), v: sh.vel.toArray().map(r2) }, false);
      }
    }
  }

  updateView(dt) {
    const v = this.view;
    v.prev.copy(v.p);
    if (this.isPilot) {
      v.p.copy(this.ship.p);
      v.q.set(...shipQuat(this.ship.yaw, this.ship.pitch));
    } else if (this.isHost) {
      if (this.remoteShip.has) {
        const a = Math.min(1, dt * 15);
        v.p.lerp(this.remoteShip.p, a);
        v.q.slerp(this.remoteShip.q, a);
      }
    } else if (this.shipBuf.size) {
      const s = this.shipBuf.sample(this.clock.remoteNow(performance.now()) - INTERP_DELAY_MS);
      v.p.set(s[0], s[1], s[2]);
      v.q.set(s[3], s[4], s[5], s[6]).normalize();
    }
    if (dt > 0) v.vel.lerp(_v.subVectors(v.p, v.prev).divideScalar(dt), 0.3);
    // The universe moves around the cockpit.
    this.space.quaternion.copy(v.q).invert();
    this.space.position.copy(v.p).applyQuaternion(this.space.quaternion).negate();
    this.sky.quaternion.copy(this.space.quaternion);
  }

  toCockpit(p) {
    return new THREE.Vector3(p[0], p[1], p[2]).sub(this.view.p).applyQuaternion(this.space.quaternion);
  }

  // ---------- weapons ----------

  canShoot(i) {
    if (this.phase !== 'play' || !this.app.hands[i].connected) return false;
    return this.isGunner || (this.isPilot && this.stick.hand !== i && this.lever.hand !== i);
  }

  updateGuns(dt) {
    this.app.hands.forEach((hand, i) => {
      const can = this.canShoot(i);
      this.guns[i].visible = can;
      hand.visual.visible = !can;
      this.cool[i] -= dt;
      if (can && hand.state.trigger.pressed && this.cool[i] <= 0 && !this.app.ui.captures(hand)) {
        this.cool[i] = this.isGunner ? 0.15 : 0.3;
        this.fire(hand.rayOrigin, hand.dir, this.isGunner ? 2 : 1, hand);
      }
    });
    // Nose guns: the trigger of the hand holding the joystick.
    this.noseCool -= dt;
    const sh = this.stick.hand;
    if (this.isPilot && this.phase === 'play' && sh >= 0 && this.app.hands[sh].state.trigger.pressed && this.noseCool <= 0) {
      this.noseCool = 0.16;
      this.noseSide = 1 - this.noseSide;
      this.fire(NOSE_GUNS[this.noseSide], _v.set(0, 0, -1).clone(), 1, this.app.hands[sh]);
    }
  }

  // origin/dir are in cockpit space.
  fire(origin, dir, dmg, hand) {
    const o = origin.clone().applyQuaternion(this.view.q).add(this.view.p);
    const d = dir.clone().applyQuaternion(this.view.q).normalize();
    const oa = o.toArray(), da = d.toArray();
    let best = null;
    let bestT = BOLT_RANGE;
    for (const e of this.statics.values()) {
      if (!e.alive || dist(e.p, oa) > BOLT_RANGE + 20) continue;
      const t = raySphere(oa, da, e.p, HIT_R[e.type]);
      if (t >= 0 && t < bestT) { bestT = t; best = e.id; }
    }
    for (const [id, v] of this.dynView) {
      const t = raySphere(oa, da, v.p, HIT_R[v.type]);
      if (t >= 0 && t < bestT) { bestT = t; best = id; }
    }
    this.spawnBolt(o, d, bestT, this.app.myColor);
    if (best !== null) {
      this.fx.burst(o.clone().addScaledVector(d, bestT), 0xffffff, 8, 10, 0.3);
      if (this.isHost) this.applyHit(best, dmg);
      else this.app.sendGame('hit', { id: best, dmg });
    }
    if (!this.solo) this.app.sendGame('bolt', { o: oa.map(r2), d: da.map(r4), len: r2(bestT) });
    this.app.sfx.laser(origin);
    hand?.pulse(0.25, 20);
  }

  spawnBolt(o, d, length, color) {
    let b = this.bolts.find((x) => !x.mesh.visible);
    if (!b) {
      b = { mesh: new THREE.Mesh(this.geos.bolt, glowMat(color)), o: new THREE.Vector3(), d: new THREE.Vector3(), t: 0, len: 0 };
      this.space.add(b.mesh);
      this.bolts.push(b);
    }
    b.mesh.material.color.set(color);
    b.o.copy(o);
    b.d.copy(d);
    b.t = 0;
    b.len = length;
    b.mesh.quaternion.setFromUnitVectors(_up, d);
    b.mesh.visible = true;
  }

  updateBolts(dt) {
    for (const b of this.bolts) {
      if (!b.mesh.visible) continue;
      b.t += BOLT_SPEED * dt;
      if (b.t > b.len) { b.mesh.visible = false; continue; }
      b.mesh.position.copy(b.o).addScaledVector(b.d, b.t + 2.5);
    }
  }

  boomFx(p, big) {
    this.fx.burst(p, big ? 0xffaa33 : 0xffddaa, big ? 120 : 35, big ? 30 : 12, big ? 1.6 : 0.8);
    const c = this.toCockpit(p);
    if (c.length() < 400) this.app.sfx.boom(c, big);
  }

  // ---------- networking ----------

  onNet(k, d) {
    switch (k) {
      case 'join':
        if (this.isHost) this.app.sendGame('roles', { roles: this.roles });
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
        for (const id of [...this.breaches.keys()]) this.removeBreach(id);
        this.roles = d.roles;
        this.shipBuf.clear();
        this.loadSector(d.level, d.seed);
        this.phase = 'play';
        this.placeRig();
        this.onStart();
        break;
      case 'level':
        if (this.isHost) return;
        this.loadSector(d.level, d.seed);
        this.phase = 'play';
        break;
      case 'phase':
        if (!this.isHost) this.phase = d.phase;
        break;
      case 'snap':
        if (this.isHost) return;
        this.clock.update(d.ts, performance.now());
        this.buf.push(d.ts, d.dyn);
        if (d.sh) this.shipBuf.push(d.ts, d.sh);
        [this.st.shield, this.st.hull, this.st.score, this.st.level, this.st.obj, this.st.objHp] = d.st;
        this.armed = new Set(d.armed);
        this.syncBreaches(d.br);
        break;
      case 'ship':
        if (!this.isHost) return;
        this.remoteShip.p.set(...d.p);
        this.remoteShip.q.set(...d.q);
        this.remoteShip.v = d.v;
        if (!this.remoteShip.has) {
          this.view.p.copy(this.remoteShip.p);
          this.view.q.copy(this.remoteShip.q);
        }
        this.remoteShip.has = true;
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
        break;
      case 'kill':
        this.onKillStatic(d.id, d.big, d.p);
        break;
      case 'boom':
        this.boomFx(d.p, d.big);
        break;
      case 'hurt':
        this.onHurt(d.hull);
        break;
      case 'msg':
        this.app.toast(d.text, 3.5);
        if (d.text.startsWith('HULL')) this.app.sfx.alarm();
        break;
      case 'over':
        if (this.isHost) return;
        this.phase = 'over';
        this.st.score = d.score;
        this.st.level = d.level;
        this.st.hull = 0;
        this.onOver();
        break;
      default:
    }
  }

  sendSnapshot(dt) {
    if (this.solo || !this.isHost || (this.phase !== 'play' && this.phase !== 'cleared')) return;
    this.sendAcc += dt;
    if (this.sendAcc < 1 / 20) return;
    this.sendAcc = 0;
    const dyn = [];
    for (const e of this.dyn.values()) dyn.push([e.id, e.type, r2(e.p[0]), r2(e.p[1]), r2(e.p[2])]);
    for (const e of this.statics.values()) if (e.moving && e.alive) dyn.push([e.id, e.type, r2(e.p[0]), r2(e.p[1]), r2(e.p[2])]);
    const sh = this.isPilot ? [...this.ship.p.toArray().map(r2), ...shipQuat(this.ship.yaw, this.ship.pitch).map(r4)] : null;
    this.app.sendGame('snap', {
      ts: performance.now(),
      sh,
      st: [Math.round(this.st.shield), Math.round(this.st.hull), this.st.score, this.st.level, this.st.obj, r2(this.st.objHp)],
      dyn,
      armed: [...this.armed],
      br: [...this.breaches.values()].map((b) => [b.id, b.spot]),
    }, false);
  }

  // ---------- drawing ----------

  removeDynView(id) {
    const v = this.dynView.get(id);
    if (!v) return;
    this.space.remove(v.mesh);
    this.dynView.delete(id);
  }

  syncDynamic() {
    let source;
    if (this.isHost) {
      source = new Map();
      for (const e of this.dyn.values()) source.set(e.id, [e.type, e.p[0], e.p[1], e.p[2]]);
    } else {
      source = this.buf.size ? this.buf.sample(this.clock.remoteNow(performance.now()) - INTERP_DELAY_MS) : new Map();
    }
    for (const [id, v] of source) {
      if (v[0] === ET.mine) {
        const m = this.statics.get(id);
        if (m && m.alive) m.p = [v[1], v[2], v[3]];
        continue;
      }
      let view = this.dynView.get(id);
      if (!view) {
        const mesh = v[0] === ET.fighter ? this.makeFighter() : this.makePlasma();
        this.space.add(mesh);
        view = { type: v[0], p: [v[1], v[2], v[3]], mesh };
        this.dynView.set(id, view);
      }
      const prev = view.p;
      view.p = [v[1], v[2], v[3]];
      view.mesh.position.set(...view.p);
      if (view.type === ET.fighter) {
        const dir = sub(view.p, prev);
        if (Math.hypot(...dir) > 1e-3) view.mesh.quaternion.setFromUnitVectors(_fwdZ, _v.set(...norm(dir)));
      }
    }
    for (const id of [...this.dynView.keys()]) if (!source.has(id)) this.removeDynView(id);
  }

  updateMines(t) {
    const blink = Math.sin(t * 25) > 0;
    for (const [id, i] of this.mineIndex) {
      const m = this.statics.get(id);
      if (!m.alive) {
        this.mines.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      _q.setFromEuler(new THREE.Euler(t * 0.7 + i, t * 0.5 + i * 2, 0));
      this.mines.setMatrixAt(i, _m.compose(_v.set(...m.p), _q, _s.set(1, 1, 1)));
      const color = this.armed.has(id) ? (blink ? 0xffffff : 0xff0000) : m.seeker ? 0xff33cc : 0xff8800;
      this.mines.setColorAt(i, _c.set(color));
    }
    this.mines.count = this.mineIndex.size;
    this.mines.instanceMatrix.needsUpdate = true;
    if (this.mines.instanceColor) this.mines.instanceColor.needsUpdate = true;
  }

  updateMap(t) {
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.view.q);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    const ship = this.view.p.toArray();
    const icons = this.mapIcons;
    const place = (mesh, p) => {
      const [x, z, h] = mapProject(ship, yaw, p, MAP_RANGE, MAP_R);
      mesh.position.set(x, THREE.MathUtils.clamp(h, -0.07, 0.07), z);
    };
    let n = 0;
    for (const e of this.statics.values()) {
      if (e.type !== ET.outpost || !e.alive) continue;
      let icon = icons.outposts[n];
      if (!icon) {
        icon = new THREE.Mesh(this.mapOutGeo, this.mapOutMat);
        this.map.add(icon);
        icons.outposts.push(icon);
      }
      const isObj = e.id === this.st.obj;
      icon.material = isObj ? this.mapObjMat : this.mapOutMat;
      icon.scale.setScalar(isObj ? 1.4 + Math.sin(t * 6) * 0.25 : 1);
      icon.visible = true;
      place(icon, e.p);
      n++;
    }
    for (let i = n; i < icons.outposts.length; i++) icons.outposts[i].visible = false;

    n = 0;
    for (const v of this.dynView.values()) {
      if (v.type !== ET.fighter) continue;
      let icon = icons.fighters[n];
      if (!icon) {
        icon = new THREE.Mesh(this.mapFighterGeo, this.mapFighterMat);
        this.map.add(icon);
        icons.fighters.push(icon);
      }
      icon.visible = true;
      place(icon, v.p);
      n++;
    }
    for (let i = n; i < icons.fighters.length; i++) icons.fighters[i].visible = false;

    n = 0;
    for (const e of this.statics.values()) {
      if (e.type !== ET.mine || !e.alive || n >= MAP_MINES || dist(e.p, ship) > MAP_RANGE * 0.4) continue;
      const [x, z, h] = mapProject(ship, yaw, e.p, MAP_RANGE, MAP_R);
      this.mapMinePos[n * 3] = x;
      this.mapMinePos[n * 3 + 1] = THREE.MathUtils.clamp(h, -0.07, 0.07);
      this.mapMinePos[n * 3 + 2] = z;
      n++;
    }
    this.mapMines.geometry.setDrawRange(0, n);
    this.mapMineAttr.needsUpdate = true;

    // Arrow + marker toward the objective.
    const obj = this.statics.get(this.st.obj);
    const show = !!obj && obj.alive && this.phase === 'play';
    this.arrow.visible = this.marker.visible = this.markerLabel.mesh.visible = show;
    if (!show) return;
    const local = this.toCockpit(obj.p);
    const d = local.length();
    this.arrow.quaternion.setFromUnitVectors(_up, local.normalize());
    const k = Math.max(1, d * 0.035);
    this.marker.position.set(...obj.p);
    this.marker.quaternion.copy(this.view.q);
    this.marker.scale.setScalar(k * 18 / 10);
    this.markerLabel.mesh.position.set(...obj.p).add(_v.set(0, k * 2.6, 0).applyQuaternion(this.view.q));
    this.markerLabel.mesh.quaternion.copy(this.view.q);
    this.markerLabel.mesh.scale.setScalar(k);
    this.markerLabel.set(`TARGET · ${Math.round(d)} m · ${Math.round(this.st.objHp * 100)}%`);
  }

  updateDust() {
    const p = this.view.p;
    const v = this.view.vel;
    const half = DUST_BOX / 2;
    const out = this.dustPos;
    const wrap = (b, c) => c + ((((b - c + half) % DUST_BOX) + DUST_BOX) % DUST_BOX) - half;
    for (let i = 0; i < DUST; i++) {
      const j = i * 3, o = i * 6;
      const x = wrap(this.dustBase[j], p.x), y = wrap(this.dustBase[j + 1], p.y), z = wrap(this.dustBase[j + 2], p.z);
      out[o] = x; out[o + 1] = y; out[o + 2] = z;
      out[o + 3] = x - v.x * 0.05; out[o + 4] = y - v.y * 0.05; out[o + 5] = z - v.z * 0.05;
    }
    this.dustAttr.needsUpdate = true;
  }

  updateHud() {
    const st = this.st;
    const speed = this.isPilot ? this.ship.speed : this.view.vel.length();
    this.hudCenter.set(this.phase === 'brief' ? 'READY FOR LAUNCH' : `LEVEL ${st.level}  ·  ${st.score} PTS`);
    const color = st.hull < 30 ? '#ff6b6b' : st.shield < 30 ? '#ffb347' : '#7dffef';
    this.hudLeft.set(`SHIELD ${Math.round(st.shield)}%\nHULL ${Math.round(st.hull)}%\nSPEED ${Math.round(speed)}`, color);
    if (this.breaches.size) this.hudRight.set(`BREACHES: ${this.breaches.size}\nFIX THEM!`, '#ff6b6b');
    else {
      const obj = this.statics.get(st.obj);
      const d = obj ? Math.round(dist(obj.p, this.view.p.toArray())) : 0;
      this.hudRight.set(`OUTPOSTS LEFT ${this.outpostsLeft()}\nTARGET ${d} m`, '#ffee33');
    }
  }

  // ---------- per-frame ----------

  update(dt, t) {
    this.updatePilot(dt);
    this.updateView(dt);
    if (this.isHost && this.phase === 'play') this.hostSim(dt);
    if (this.isHost && this.phase === 'cleared') {
      this.clearT -= dt;
      if (this.clearT <= 0) this.nextLevel();
    }
    this.sendSnapshot(dt);
    if (this.sector) {
      this.syncDynamic();
      this.updateMines(t);
      this.updateMap(t);
      for (const mesh of this.staticViews.values()) {
        const b = mesh.userData.beacon;
        if (b) b.scale.setScalar(1 + Math.sin(t * 4) * 0.3);
      }
    }
    this.updateGuns(dt);
    this.updateBolts(dt);
    if (this.phase === 'play') this.updateRepairs(dt);
    this.fx.update(dt);
    this.updateDust();

    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.banner.mesh.visible = false;
    }

    this.hurt = Math.max(0, this.hurt - dt * 1.5);
    this.hurtMesh.material.opacity = this.hurt * 0.5;
    this.hurtMesh.visible = this.hurt > 0;

    this.hudAcc -= dt;
    if (this.hudAcc <= 0) {
      this.hudAcc = 0.25;
      this.updateHud();
    }
  }

  dispose() {
    for (const h of this.app.hands) h.visual.visible = true;
    this.app.camera.far = 1000;
    this.app.camera.updateProjectionMatrix();
    super.dispose();
  }
}
