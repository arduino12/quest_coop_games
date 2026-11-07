import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { glowMat, lineMat } from '../../core/env.js';
import { smoothMove, snapTurn } from '../../core/locomotion.js';
import { r2 } from '../../core/sync.js';
import {
  TOPPINGS, SIZES, DOUGH_START, BAKE_DONE, BAKE_BURNT, BAKE_TIME, SHIFT_TIME, PENALTY,
  sizeOf, shiftConfig, orderStream, orderText, problems, matchOrder, payFor, stars,
} from './logic.js';

const COUNTER_Y = 0.9;
const COUNTERS = [
  { x0: -2.3, x1: 2.3, z0: -1.1, z1: -0.35 },
  { x0: -2.3, x1: -1.7, z0: -1.1, z1: 0.8 },
  { x0: 1.7, x1: 2.3, z0: -1.1, z1: 0.8 },
];
const BOARDS = [[-0.55, -0.62], [0.55, -0.62]];
const DOUGH_BINS = [['classic', -2.0, -0.6], ['wholewheat', -2.0, -0.2], ['charcoal', -2.0, 0.2]];
const TOP_BINS = TOPPINGS.map((t, i) => [t, -1.25 + i * 0.5, -0.86]);
const CHEESE_BIN = [0, -0.82];
const SLOTS = [[1.92, 1.05, -0.35], [1.92, 1.4, -0.35]];
const SERVE = [2.0, 0.45];
const TRASH = [-1.5, 0.6];
const DOUGH_HEX = { classic: 0xe8c890, wholewheat: 0xa87848, charcoal: 0x3a3a3a };
const SAUCE_HEX = { tomato: 0xc8281e, white: 0xf2ead8 };
const TOP_HEX = { pepperoni: 0xb82020, mushroom: 0xc8b49a, olive: 0x1e1e1e, pepper: 0x2fa83a, onion: 0xf0e6ff, pineapple: 0xf5d442 };
const RIG = { host: [-0.55, 0.2], guest: [0.55, 0.2] };
const BOT_HOME = [1.3, 1.65, -0.2];
const GRAVITY = 9.8;
const _v = new THREE.Vector3();

const surfaceY = (x, z) => (COUNTERS.some((c) => x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1) ? COUNTER_Y : 0);
const halfH = (it) => (it.kind === 'pizza' ? 0.012 : it.kind === 'bottle' ? 0.1 : 0.02);
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

// Co-op kitchen. The host runs everything (items, orders, oven, robot); the guest holds items in
// their own hands without lag and streams those positions to the host.
export class Pizza extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.phase = 'brief'; // brief -> shift -> over
    this.shift = 1;
    this.botOn = this.solo;
    this.items = new Map();
    this.views = new Map();
    this.orders = [];
    this.score = 0;
    this.served = 0;
    this.timeLeft = SHIFT_TIME;
    this.nextId = 1;
    this.orderT = 0;
    this.localHold = new Map(); // guest: hand -> item id (predicted)
    this.pendingSpawn = [false, false];
    this.stretch = null; // { id, d0, start }
    this.bot = { p: BOT_HOME.slice(), task: null, item: null };
    this.sendAcc = 0;
    this.moveAcc = 0;
    this.turn = { ready: true };

    this.buildKitchen();
    const [x, z] = RIG[this.mySide];
    app.setRig(this.solo ? 0 : x, 0, z, 0);
    this.spawnBottles();
    this.refreshPanel();
    if (!this.isHost) app.sendGame('join');
  }

  // ---------- kitchen ----------

  buildKitchen() {
    const root = this.root;
    this.app.scene.background = new THREE.Color(0x2a2230);
    root.add(new THREE.HemisphereLight(0xfff4e0, 0x403020, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(1, 4, 2);
    root.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), new THREE.MeshLambertMaterial({ color: 0x5a4a44 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -0.2;
    root.add(floor);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 3.2), new THREE.MeshLambertMaterial({ color: 0xd8c8b0 }));
    wall.position.set(0, 1.6, -1.2);
    root.add(wall);
    const top = new THREE.MeshLambertMaterial({ color: 0xe8e4dc });
    const body = new THREE.MeshLambertMaterial({ color: 0x8a4a3a });
    for (const c of COUNTERS) {
      const w = c.x1 - c.x0, d = c.z1 - c.z0;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, COUNTER_Y - 0.04, d), body);
      b.position.set((c.x0 + c.x1) / 2, (COUNTER_Y - 0.04) / 2, (c.z0 + c.z1) / 2);
      const t = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.04, d + 0.02), top);
      t.position.set(b.position.x, COUNTER_Y - 0.02, b.position.z);
      root.add(b, t);
    }
    // Prep boards with S / M / L guide rings.
    for (const [x, z] of BOARDS) {
      const board = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.012, 32), new THREE.MeshLambertMaterial({ color: 0xb08850 }));
      board.position.set(x, COUNTER_Y + 0.003, z);
      root.add(board);
      for (const [k, d] of Object.entries(SIZES)) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(d / 2 - 0.003, d / 2, 48), new THREE.MeshBasicMaterial({ color: 0x3a2a1a }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, COUNTER_Y + 0.0105, z);
        root.add(ring);
        const tag = new Label(k, { w: 0.04, h: 0.03, color: '#3a2a1a' });
        tag.mesh.rotation.x = -Math.PI / 2;
        tag.mesh.position.set(x + d / 2 - 0.012, COUNTER_Y + 0.011, z + 0.02);
        root.add(tag.mesh);
      }
    }
    // Bins.
    const tray = new THREE.MeshLambertMaterial({ color: 0x9aa4b0 });
    const bin = (x, z, label, sample) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.16), tray);
      b.position.set(x, COUNTER_Y + 0.025, z);
      root.add(b);
      if (sample) { sample.position.set(x, COUNTER_Y + 0.06, z); root.add(sample); }
      const tag = new Label(label, { w: 0.22, h: 0.045, color: '#222', bg: '#f4efe4', size: 0.7 });
      tag.mesh.position.set(x, COUNTER_Y + 0.12, z - 0.07);
      root.add(tag.mesh);
    };
    for (const [d, x, z] of DOUGH_BINS) bin(x, z, `${d} dough`, this.doughBall(d));
    for (const [t, x, z] of TOP_BINS) bin(x, z, t, this.toppingMesh(t));
    bin(CHEESE_BIN[0], CHEESE_BIN[1], 'cheese', this.cheeseMesh());

    // Oven with two slots.
    const oven = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.8, 0.7), new THREE.MeshLambertMaterial({ color: 0x3a3f48 }));
    oven.position.set(2.05, COUNTER_Y + 0.4, -0.35);
    root.add(oven);
    this.slotGlow = SLOTS.map(([x, y, z]) => {
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.5), glowMat(0xff7a1a, 0.9));
      glow.position.set(x - 0.06, y + 0.02, z);
      root.add(glow);
      return glow;
    });
    this.ovenLabel = new Label('', { w: 0.5, h: 0.16, color: '#ffb347', bg: 'rgba(20,10,0,0.85)', size: 0.75 });
    this.ovenLabel.mesh.position.set(1.72, 1.85, -0.35);
    this.ovenLabel.mesh.rotation.y = -0.9;
    root.add(this.ovenLabel.mesh);
    // Serving window and trash.
    const serve = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.01, 0.4), glowMat(0x7dff8a, 0.5));
    serve.position.set(SERVE[0], COUNTER_Y + 0.006, SERVE[1]);
    root.add(serve);
    const serveTag = new Label('SERVE', { w: 0.3, h: 0.08, color: '#7dff8a' });
    serveTag.mesh.position.set(SERVE[0] - 0.1, COUNTER_Y + 0.25, SERVE[1]);
    serveTag.mesh.rotation.y = -Math.PI / 2;
    root.add(serveTag.mesh);
    const trash = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.6, 20, 1, true), new THREE.MeshLambertMaterial({ color: 0x444a50, side: THREE.DoubleSide }));
    trash.position.set(TRASH[0], 0.3, TRASH[1]);
    root.add(trash);
    const trashTag = new Label('TRASH', { w: 0.24, h: 0.06, color: '#ff6b6b' });
    trashTag.mesh.position.set(TRASH[0], 0.75, TRASH[1]);
    root.add(trashTag.mesh);

    // Orders rail, scoreboard, robot and the panel.
    this.tickets = Array.from({ length: 5 }, (_, i) => {
      const l = new Label('', { w: 0.62, h: 0.3, res: 512, size: 0.62, bg: '#fffbe8', color: '#222' });
      l.mesh.position.set(-1.36 + i * 0.68, 1.95, -1.15);
      root.add(l.mesh);
      return l;
    });
    this.board = new Label('', { w: 2.2, h: 0.16, res: 1024, size: 0.7, color: '#ffffff', bg: 'rgba(30,20,30,0.8)' });
    this.board.mesh.position.set(0, 2.32, -1.15);
    root.add(this.board.mesh);
    this.botMesh = new THREE.Group();
    const botBody = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), new THREE.MeshLambertMaterial({ color: 0xdfe6f0 }));
    const botEye = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.02), glowMat(0x22e6ff));
    botEye.position.set(0, 0.02, 0.11);
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.12, 16), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    hat.position.y = 0.15;
    this.botMesh.add(botBody, botEye, hat);
    this.botMesh.visible = false;
    root.add(this.botMesh);
    this.panel = this.app.ui.add(new Panel({ w: 1.3, h: 0.95, accent: '#ffb347', cols: 2 }));
    this.panel.mesh.position.set(0, 1.45, -0.95);
    root.add(this.panel.mesh);
    this.sizeLabel = new Label('', { w: 0.3, h: 0.07, color: '#ffffff', bg: 'rgba(0,0,0,0.6)' });
    this.sizeLabel.mesh.visible = false;
    root.add(this.sizeLabel.mesh);
  }

  doughBall(d) {
    return new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 10), new THREE.MeshLambertMaterial({ color: DOUGH_HEX[d] }));
  }

  toppingMesh(t) {
    const mat = new THREE.MeshLambertMaterial({ color: TOP_HEX[t] });
    if (t === 'pepperoni') return new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.006, 14), mat);
    if (t === 'mushroom') return new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    if (t === 'olive' || t === 'onion') {
      const m = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.005, 6, 14), mat);
      m.rotation.x = Math.PI / 2;
      const g = new THREE.Group();
      g.add(m);
      return g;
    }
    return new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.01, 0.018), mat);
  }

  cheeseMesh() {
    return new THREE.Mesh(new THREE.DodecahedronGeometry(0.03, 0), new THREE.MeshLambertMaterial({ color: 0xfff2a8, flatShading: true }));
  }

  // ---------- items (host) ----------

  addItem(it) {
    it.id = this.nextId++;
    it.held = it.held ?? null;
    it.hand = it.hand ?? -1;
    it.vy = 0;
    this.items.set(it.id, it);
    return it;
  }

  spawnBottles() {
    if (!this.isHost) return;
    this.addItem({ kind: 'bottle', sauce: 'tomato', p: [-0.12, COUNTER_Y + 0.1, -0.48] });
    this.addItem({ kind: 'bottle', sauce: 'white', p: [0.12, COUNTER_Y + 0.1, -0.48] });
  }

  newPizza(dough, p) {
    return this.addItem({ kind: 'pizza', dough, size: DOUGH_START, sauce: null, sauceAmt: 0, cheese: false, toppings: [], bake: 0, slot: null, p });
  }

  binAt(p) {
    for (const [d, x, z] of DOUGH_BINS) if (Math.hypot(p[0] - x, p[1] - COUNTER_Y - 0.05, p[2] - z) < 0.16) return { kind: 'pizza', dough: d };
    for (const [t, x, z] of TOP_BINS) if (Math.hypot(p[0] - x, p[1] - COUNTER_Y - 0.05, p[2] - z) < 0.14) return { kind: 'top', t };
    if (Math.hypot(p[0] - CHEESE_BIN[0], p[1] - COUNTER_Y - 0.05, p[2] - CHEESE_BIN[1]) < 0.14) return { kind: 'cheese' };
    return null;
  }

  spawnFromBin(bin, p, holder, hand) {
    const it = bin.kind === 'pizza' ? this.newPizza(bin.dough, p) : this.addItem({ kind: bin.kind, t: bin.t, p });
    it.held = holder;
    it.hand = hand;
    return it;
  }

  nearestItem(p, except = null) {
    let best = null, bestD = Infinity;
    for (const it of this.items.values()) {
      if (it === except || it.held === 'bot') continue;
      const d = it.kind === 'pizza'
        ? (hdist(p, it.p) < it.size / 2 + 0.04 && Math.abs(p[1] - it.p[1]) < 0.12 ? hdist(p, it.p) * 0.5 : Infinity)
        : Math.hypot(p[0] - it.p[0], p[1] - it.p[1], p[2] - it.p[2]) < 0.12 ? Math.hypot(p[0] - it.p[0], p[1] - it.p[1], p[2] - it.p[2]) : Infinity;
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  // Where a released item ends up: on a pizza, in the oven, served, in the trash, or on a surface.
  resolveRelease(it) {
    it.held = null;
    it.hand = -1;
    it.vy = 0;
    if (hdist(it.p, [TRASH[0], 0, TRASH[1]]) < 0.3 && it.p[1] < 1.1 && it.kind !== 'bottle') {
      this.removeItem(it, 'trash');
      return;
    }
    if (it.kind === 'top' || it.kind === 'cheese') {
      for (const pz of this.items.values()) {
        if (pz.kind !== 'pizza' || pz.held || pz.slot !== null || pz.bake > 0.2) continue;
        if (hdist(it.p, pz.p) < pz.size / 2 + 0.03 && it.p[1] > pz.p[1] - 0.05 && it.p[1] < pz.p[1] + 0.4) {
          if (it.kind === 'cheese') pz.cheese = true;
          else {
            const r = Math.min(hdist(it.p, pz.p), pz.size / 2 - 0.03);
            const a = Math.atan2(it.p[2] - pz.p[2], it.p[0] - pz.p[0]);
            pz.toppings.push({ t: it.t, x: Math.cos(a) * r, z: Math.sin(a) * r });
          }
          this.removeItem(it, 'onto');
          this.app.sfx.thunk(pz.p);
          return;
        }
      }
    }
    if (it.kind === 'pizza') {
      const k = SLOTS.findIndex((s, i) => Math.hypot(it.p[0] - s[0], it.p[1] - s[1], it.p[2] - s[2]) < 0.3 && ![...this.items.values()].some((o) => o.slot === i));
      if (k >= 0) {
        it.slot = k;
        it.p = SLOTS[k].slice();
        this.app.sfx.tone({ f: 300, dur: 0.15, type: 'triangle', vol: 0.2, pos: it.p });
        return;
      }
      if (hdist(it.p, [SERVE[0], 0, SERVE[1]]) < 0.32 && Math.abs(it.p[1] - COUNTER_Y) < 0.4) {
        this.serve(it);
        return;
      }
    }
  }

  removeItem(it) {
    this.items.delete(it.id);
  }

  serve(pz) {
    this.removeItem(pz);
    const order = matchOrder(pz, this.orders);
    if (order) {
      const pay = payFor(order);
      this.score += pay;
      this.served++;
      this.orders = this.orders.filter((o) => o !== order);
      this.say(`Order #${order.id} served! +${pay}`, 'cash');
    } else {
      this.score -= PENALTY.wrong;
      const oldest = [...this.orders].sort((a, b) => b.age - a.age)[0];
      const why = oldest ? problems(pz, oldest).slice(0, 3).join(', ') : 'no order';
      this.say(`Wrong pizza (-${PENALTY.wrong}): ${why}`, 'wrong');
    }
  }

  say(text, sound) {
    this.app.toast(text, 2.5);
    this.playSound(sound);
    if (!this.solo) this.app.sendGame('say', { text, sound });
  }

  playSound(sound) {
    const sfx = this.app.sfx;
    if (sound === 'cash') sfx.goal(true);
    else if (sound === 'wrong') sfx.tone({ f: 150, dur: 0.4, type: 'sawtooth', vol: 0.25 });
    else if (sound === 'ding') sfx.tone({ f: 1320, dur: 0.5, type: 'sine', vol: 0.3, pos: SLOTS[0] });
    else if (sound === 'burn') sfx.alarm();
  }

  // ---------- host simulation ----------

  hostSim(dt) {
    const cfg = shiftConfig(this.shift);
    this.timeLeft -= dt;
    this.orderT -= dt;
    if (this.orderT <= 0 && this.orders.length < cfg.maxActive) {
      this.orderT = cfg.every;
      const o = this.nextOrder(this.shift);
      o.age = 0;
      this.orders.push(o);
      this.say(`New order #${o.id}!`, null);
    }
    for (const o of [...this.orders]) {
      o.age += dt;
      if (o.age >= o.timeout) {
        this.orders = this.orders.filter((x) => x !== o);
        this.score -= PENALTY.expired;
        this.say(`Order #${o.id} walked out (-${PENALTY.expired})`, 'wrong');
      }
    }
    for (const it of this.items.values()) {
      if (it.slot !== null) {
        const before = it.bake;
        it.bake += dt / BAKE_TIME;
        if (before < BAKE_DONE && it.bake >= BAKE_DONE) this.say('Pizza ready! Take it out!', 'ding');
        if (before < BAKE_BURNT && it.bake >= BAKE_BURNT) this.say('Something is burning!', 'burn');
        continue;
      }
      if (it.held) continue;
      const floor = surfaceY(it.p[0], it.p[2]) + halfH(it);
      if (it.p[1] > floor + 1e-3) {
        it.vy -= GRAVITY * dt;
        it.p[1] = Math.max(floor, it.p[1] + it.vy * dt);
        if (it.p[1] === floor) it.vy = 0;
      }
    }
    if (this.botOn) this.botSim(dt);
    if (this.timeLeft <= 0) this.endShift();
  }

  // The robot helper: serves ready pizzas from the oven and puts out dough for open orders.
  botSim(dt) {
    const bot = this.bot;
    if (!bot.task) {
      const ready = [...this.items.values()].find((it) => it.slot !== null && it.bake >= BAKE_DONE && !it.held);
      if (ready) bot.task = { type: 'serve', id: ready.id, step: 'go' };
      else {
        const raw = [...this.items.values()].filter((it) => it.kind === 'pizza' && it.bake < 0.2).length;
        const board = BOARDS.find(([x, z]) => ![...this.items.values()].some((it) => it.kind === 'pizza' && hdist(it.p, [x, 0, z]) < 0.2));
        const order = [...this.orders].sort((a, b) => b.age - a.age)[raw];
        if (order && board) bot.task = { type: 'dough', dough: order.dough, board, step: 'go' };
      }
    }
    const t = bot.task;
    const moveTo = (target) => {
      const d = [target[0] - bot.p[0], target[1] - bot.p[1], target[2] - bot.p[2]];
      const l = Math.hypot(...d);
      const s = Math.min(l, 1.6 * dt);
      if (l > 1e-6) for (let k = 0; k < 3; k++) bot.p[k] += (d[k] / l) * s;
      return l < 0.03;
    };
    const carry = () => {
      const it = this.items.get(bot.item);
      if (it) it.p = [bot.p[0], bot.p[1] - 0.17, bot.p[2]];
      return it;
    };
    if (!t) { moveTo(BOT_HOME); return; }
    if (t.type === 'serve') {
      const it = this.items.get(t.id);
      if (!it || (it.held && it.held !== 'bot')) { bot.task = null; bot.item = null; return; }
      if (t.step === 'go' && moveTo([it.p[0] - 0.1, it.p[1] + 0.17, it.p[2]])) {
        it.held = 'bot';
        it.slot = null;
        bot.item = it.id;
        t.step = 'carry';
      } else if (t.step === 'carry') {
        carry();
        if (moveTo([SERVE[0], COUNTER_Y + 0.3, SERVE[1]])) {
          it.p = [SERVE[0], COUNTER_Y + 0.05, SERVE[1]];
          this.resolveRelease(it);
          bot.item = null;
          bot.task = null;
        }
      }
    } else if (t.type === 'dough') {
      const [, bx, bz] = DOUGH_BINS.find(([d]) => d === t.dough);
      if (t.step === 'go' && moveTo([bx, COUNTER_Y + 0.25, bz])) {
        const it = this.newPizza(t.dough, [bx, COUNTER_Y + 0.08, bz]);
        it.held = 'bot';
        bot.item = it.id;
        t.step = 'carry';
      } else if (t.step === 'carry') {
        const it = carry();
        if (!it) { bot.task = null; return; }
        if (moveTo([t.board[0], COUNTER_Y + 0.25, t.board[1]])) {
          it.held = null;
          bot.item = null;
          bot.task = null;
        }
      }
    }
  }

  endShift() {
    this.phase = 'over';
    this.timeLeft = 0;
    this.say(`Shift over! ${this.score} points, ${'★'.repeat(stars(this.score)) || 'no stars'}`, 'cash');
    this.refreshPanel();
  }

  startShift(n) {
    if (!this.isHost) { this.app.sendGame('start', { n }); return; }
    this.shift = n;
    this.seed = Math.floor(Math.random() * 1e9);
    this.nextOrder = orderStream(this.seed);
    for (const it of [...this.items.values()]) if (it.kind !== 'bottle') this.items.delete(it.id);
    this.orders = [];
    this.score = 0;
    this.served = 0;
    this.timeLeft = SHIFT_TIME;
    this.orderT = 1;
    this.bot = { p: BOT_HOME.slice(), task: null, item: null };
    this.phase = 'shift';
    this.refreshPanel();
    this.app.toast(`SHIFT ${n}: orders are coming in!`, 3);
  }

  // ---------- my hands ----------

  updateHands(dt) {
    const app = this.app;
    const playing = this.phase === 'shift';
    app.hands.forEach((hand, i) => {
      if (!hand.connected) return;
      const p = hand.pos.toArray();
      if (hand.state.squeeze.down && playing && !app.ui.captures(hand)) this.grab(i, p);
      if (hand.state.squeeze.up) this.release(i);
    });
    this.updateHeldItems(dt);
  }

  heldBy(i) {
    if (this.isHost) return [...this.items.values()].find((it) => it.held === this.mySide && it.hand === i) || null;
    const id = this.localHold.get(i);
    return id !== undefined ? this.items.get(id) || null : null;
  }

  grab(i, p) {
    const other = this.heldBy(1 - i);
    const target = this.nearestItem(p);
    // Second hand near the dough you are holding: stretch it.
    if (other && other.kind === 'pizza' && other.bake < 0.2 && hdist(p, other.p) < other.size / 2 + 0.15 && Math.abs(p[1] - other.p[1]) < 0.15) {
      this.stretch = { id: other.id, d0: other.size, start: this.app.hands[0].pos.distanceTo(this.app.hands[1].pos) };
      this.app.hands[i].pulse(0.3, 30);
      return;
    }
    if (target && !target.held) {
      if (this.isHost) { target.held = this.mySide; target.hand = i; target.slot = null; }
      else { this.localHold.set(i, target.id); this.app.sendGame('grab', { id: target.id, hand: i }); }
      this.app.hands[i].pulse(0.3, 25);
      this.app.sfx.click();
      return;
    }
    const bin = this.binAt(p);
    if (bin) {
      if (this.isHost) this.spawnFromBin(bin, p, this.mySide, i);
      else { this.pendingSpawn[i] = true; this.app.sendGame('spawn', { bin, p, hand: i }); }
      this.app.hands[i].pulse(0.3, 25);
      this.app.sfx.click();
    }
  }

  release(i) {
    this.pendingSpawn[i] = false;
    if (this.stretch) {
      const id = this.stretch.id;
      this.stretch = null;
      // Whichever hand let go, the other one keeps the pizza.
      const it = this.heldBy(i);
      if (it && it.id === id) {
        if (this.isHost) it.hand = 1 - i;
        else { this.localHold.delete(i); this.localHold.set(1 - i, id); }
      }
      return;
    }
    const it = this.heldBy(i);
    if (!it) return;
    if (this.isHost) this.resolveRelease(it);
    else {
      this.localHold.delete(i);
      this.app.sendGame('release', { id: it.id, p: it.p.map(r2), size: it.size });
    }
  }

  updateHeldItems(dt) {
    const app = this.app;
    const hands = app.hands;
    if (this.stretch) {
      const it = this.items.get(this.stretch.id);
      if (!it || !hands[0].state.squeeze.pressed || !hands[1].state.squeeze.pressed) this.stretch = null;
      else {
        const d = hands[0].pos.distanceTo(hands[1].pos);
        it.size = THREE.MathUtils.clamp(this.stretch.d0 + (d - this.stretch.start), 0.14, 0.46);
        _v.addVectors(hands[0].pos, hands[1].pos).multiplyScalar(0.5);
        it.p = [_v.x, _v.y - 0.03, _v.z];
      }
    }
    hands.forEach((hand, i) => {
      const it = this.heldBy(i);
      if (!it || (this.stretch && this.stretch.id === it.id)) return;
      it.p = [hand.pos.x, hand.pos.y - (it.kind === 'pizza' ? 0.03 : 0), hand.pos.z];
      if (it.kind === 'bottle' && hand.state.trigger.pressed) this.squeezeSauce(it, dt);
    });
    if (!this.isHost) {
      this.moveAcc += dt;
      if (this.moveAcc >= 0.05) {
        this.moveAcc = 0;
        for (const id of new Set(this.localHold.values())) {
          const it = this.items.get(id);
          if (it) app.sendGame('move', { id, p: it.p.map(r2), size: it.size, sq: it.kind === 'bottle' && hands.some((h, i) => this.localHold.get(i) === id && h.state.trigger.pressed) }, false);
        }
      }
    }
  }

  // Sauce lands on the pizza under the nozzle.
  squeezeSauce(bottle, dt) {
    const nozzle = [bottle.p[0], bottle.p[1] - 0.12, bottle.p[2]];
    for (const pz of this.items.values()) {
      if (pz.kind !== 'pizza' || pz.slot !== null || pz.bake > 0.2) continue;
      if (hdist(nozzle, pz.p) < pz.size / 2 && nozzle[1] > pz.p[1] && nozzle[1] < pz.p[1] + 0.45) {
        if (pz.sauce && pz.sauce !== bottle.sauce) return;
        pz.sauce = bottle.sauce;
        pz.sauceAmt = Math.min(1, pz.sauceAmt + dt * 0.35);
        if (Math.random() < 0.3) this.app.particles.burst(nozzle, SAUCE_HEX[bottle.sauce], 2, 0.3, 0.3, 3);
        return;
      }
    }
  }

  // ---------- networking ----------

  onNet(k, d) {
    if (this.isHost) {
      const it = d && d.id !== undefined ? this.items.get(d.id) : null;
      if (k === 'join') this.sendState(true);
      else if (k === 'start' && this.phase !== 'shift') this.startShift(d.n);
      else if (k === 'bot') { this.botOn = d.on; this.refreshPanel(); }
      else if (k === 'grab' && it) {
        if (it.held && it.held !== 'guest') this.app.sendGame('deny', { id: it.id });
        else { it.held = 'guest'; it.hand = d.hand; it.slot = null; }
      } else if (k === 'spawn' && this.phase === 'shift') this.spawnFromBin(d.bin, d.p, 'guest', d.hand);
      else if (k === 'move' && it && it.held === 'guest') {
        it.p = d.p;
        if (it.kind === 'pizza' && it.bake < 0.2) it.size = d.size;
        it.squeezing = d.sq;
      } else if (k === 'release' && it && it.held === 'guest') {
        it.p = d.p;
        if (it.kind === 'pizza') it.size = d.size;
        it.squeezing = false;
        this.resolveRelease(it);
      }
      return;
    }
    if (k === 'state') this.applyState(d);
    else if (k === 'deny') { for (const [h, id] of this.localHold) if (id === d.id) this.localHold.delete(h); }
    else if (k === 'say') { this.app.toast(d.text, 2.5); this.playSound(d.sound); }
  }

  sendState() {
    if (this.solo) return;
    const items = [...this.items.values()].map((it) => ({
      i: it.id, k: it.kind, p: it.p.map(r2), h: it.held, n: it.hand,
      ...(it.kind === 'pizza' ? { d: it.dough, sz: r2(it.size), sa: it.sauce, am: r2(it.sauceAmt), c: it.cheese, b: r2(it.bake), sl: it.slot, tp: it.toppings.map((t) => [TOPPINGS.indexOf(t.t), r2(t.x), r2(t.z)]) } : {}),
      ...(it.kind === 'top' ? { t: it.t } : {}),
      ...(it.kind === 'bottle' ? { s: it.sauce } : {}),
    }));
    this.app.sendGame('state', {
      ph: this.phase, sh: this.shift, t: Math.round(this.timeLeft), sc: this.score, sv: this.served, bot: this.botOn ? this.bot.p.map(r2) : null, botOn: this.botOn,
      orders: this.orders.map((o) => ({ ...o, age: Math.round(o.age) })), items,
    }, false);
  }

  applyState(s) {
    const phaseChanged = s.ph !== this.phase || s.botOn !== this.botOn;
    this.phase = s.ph;
    this.shift = s.sh;
    this.timeLeft = s.t;
    this.score = s.sc;
    this.served = s.sv;
    this.botOn = s.botOn;
    this.bot.p = s.bot || BOT_HOME.slice();
    this.orders = s.orders;
    const seen = new Set();
    for (const x of s.items) {
      seen.add(x.i);
      let it = this.items.get(x.i);
      if (!it) { it = { id: x.i, kind: x.k, p: x.p.slice(), target: x.p }; this.items.set(x.i, it); }
      const mine = [...this.localHold.values()].includes(x.i);
      // An item the host gave me (from a bin) while my hand is still squeezing: take it.
      if (!mine && x.h === 'guest' && x.n >= 0 && this.pendingSpawn[x.n] && this.app.hands[x.n].state.squeeze.pressed) {
        this.localHold.set(x.n, x.i);
        this.pendingSpawn[x.n] = false;
      } else if (!mine && x.h === 'guest' && !this.pendingSpawn[x.n]) {
        // The host thinks I hold it but I already let go: drop it where it is.
        this.app.sendGame('release', { id: x.i, p: x.p, size: x.sz });
      }
      it.held = x.h;
      it.target = x.p;
      if (x.k === 'pizza') {
        Object.assign(it, { dough: x.d, sauce: x.sa, sauceAmt: x.am, cheese: x.c, bake: x.b, slot: x.sl, toppings: x.tp.map(([t, tx, tz]) => ({ t: TOPPINGS[t], x: tx, z: tz })) });
        if (!mine) it.size = x.sz;
        else it.size = it.size ?? x.sz;
      }
      if (x.k === 'top') it.t = x.t;
      if (x.k === 'bottle') it.sauce = x.s;
    }
    for (const id of [...this.items.keys()]) if (!seen.has(id)) this.items.delete(id);
    if (phaseChanged) this.refreshPanel();
  }

  // ---------- drawing ----------

  syncViews(dt) {
    for (const [id, it] of this.items) {
      let v = this.views.get(id);
      if (!v) {
        v = this.makeView(it);
        this.views.set(id, v);
        this.root.add(v.mesh);
      }
      // Guest: smooth toward the host's position unless I'm holding it.
      if (!this.isHost && it.target && ![...this.localHold.values()].includes(id)) {
        for (let k = 0; k < 3; k++) it.p[k] += (it.target[k] - it.p[k]) * Math.min(1, dt * 15);
      }
      v.mesh.position.set(it.p[0], it.p[1], it.p[2]);
      if (it.kind === 'pizza') this.updatePizzaView(v, it);
    }
    for (const [id, v] of this.views) {
      if (!this.items.has(id)) { this.root.remove(v.mesh); this.views.delete(id); }
    }
  }

  makeView(it) {
    if (it.kind === 'top') return { mesh: this.toppingMesh(it.t) };
    if (it.kind === 'cheese') return { mesh: this.cheeseMesh() };
    if (it.kind === 'bottle') {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.16, 16), new THREE.MeshLambertMaterial({ color: SAUCE_HEX[it.sauce] }));
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.05, 12), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      tip.rotation.x = Math.PI;
      tip.position.y = -0.1;
      body.position.y = 0.0;
      g.add(body, tip);
      return { mesh: g };
    }
    const g = new THREE.Group();
    const disc = new THREE.CylinderGeometry(0.5, 0.5, 0.02, 32);
    const dough = new THREE.Mesh(disc, new THREE.MeshLambertMaterial({ color: DOUGH_HEX[it.dough] }));
    const sauce = new THREE.Mesh(disc, new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true }));
    sauce.position.y = 0.006;
    const cheese = new THREE.Mesh(disc, new THREE.MeshLambertMaterial({ color: 0xffe9a0 }));
    cheese.position.y = 0.01;
    const tops = new THREE.Group();
    tops.position.y = 0.017;
    g.add(dough, sauce, cheese, tops);
    return { mesh: g, dough, sauce, cheese, tops, topCount: -1, base: new THREE.Color(DOUGH_HEX[it.dough]) };
  }

  updatePizzaView(v, it) {
    const s = it.size;
    v.dough.scale.set(s, 1, s);
    v.sauce.visible = !!it.sauce && it.sauceAmt > 0.02;
    if (v.sauce.visible) {
      v.sauce.material.color.set(SAUCE_HEX[it.sauce]);
      v.sauce.material.opacity = 0.3 + 0.7 * it.sauceAmt;
      v.sauce.scale.set(s * 0.88 * Math.min(1, 0.4 + it.sauceAmt * 0.6), 1, s * 0.88 * Math.min(1, 0.4 + it.sauceAmt * 0.6));
    }
    v.cheese.visible = !!it.cheese;
    v.cheese.scale.set(s * 0.82, 1, s * 0.82);
    // Baking browns the dough, then chars it.
    const b = Math.min(it.bake, 2);
    const c = v.base.clone().lerp(new THREE.Color(0x9a5a20), Math.min(1, b) * 0.6);
    if (b > BAKE_DONE) c.lerp(new THREE.Color(0x111111), Math.min(1, (b - BAKE_DONE) / (BAKE_BURNT - BAKE_DONE)));
    v.dough.material.color.copy(c);
    v.cheese.material.color.set(b > 0.6 ? 0xf2c060 : 0xffe9a0);
    if (v.topCount !== it.toppings.length) {
      v.topCount = it.toppings.length;
      v.tops.clear();
      for (const t of it.toppings) {
        const m = this.toppingMesh(t.t);
        m.position.set(t.x, 0, t.z);
        v.tops.add(m);
      }
    }
  }

  refreshPanel() {
    const p = this.panel;
    if (this.phase === 'brief' || this.phase === 'over') {
      const over = this.phase === 'over';
      p.set({
        title: over ? `SHIFT ${this.shift} DONE · ${this.score} pts ${'★'.repeat(stars(this.score))}` : 'PIZZA RUSH',
        lines: over ? [`${this.served} pizzas served.`] : [
          'Read the order tickets. Grab dough (left), stretch it with both hands to the size ring, squeeze sauce, add cheese and toppings.',
          'Bake it in the oven (right) until golden, then put it on the green SERVE spot. Do not burn it!',
          this.solo ? 'Your robot helper preps dough and serves pizzas from the oven.' : 'Split the jobs with your partner. Left stick walks, right stick turns.',
        ],
        buttons: [
          { label: over ? `Shift ${this.shift + 1}` : 'Start shift', onClick: () => this.startShift(over ? this.shift + 1 : 1) },
          { label: `Robot: ${this.botOn ? 'ON' : 'OFF'}`, onClick: () => this.toggleBot() },
          ...(over ? [{ label: 'Menu', onClick: () => this.app.requestGame('lobby') }] : []),
        ],
        cols: over ? 3 : 2,
      });
      p.mesh.visible = true;
    } else p.mesh.visible = false;
  }

  toggleBot() {
    if (this.isHost) { this.botOn = !this.botOn; this.refreshPanel(); }
    else this.app.sendGame('bot', { on: !this.botOn });
  }

  refreshBoards() {
    const now = this.orders.slice(0, 5);
    this.tickets.forEach((l, i) => {
      const o = now[i];
      l.mesh.visible = !!o;
      if (!o) return;
      const left = Math.max(0, Math.ceil(o.timeout - o.age));
      l.set(`#${o.id}   ${left}s\n${orderText(o)}`, left < 15 ? '#c0201a' : '#222222');
    });
    const m = Math.floor(Math.max(0, this.timeLeft) / 60), s = Math.floor(Math.max(0, this.timeLeft) % 60);
    this.board.set(this.phase === 'shift' ? `SHIFT ${this.shift}   ·   ${m}:${String(s).padStart(2, '0')}   ·   ${this.score} pts   ·   served ${this.served}` : 'PIZZA RUSH');
    const ovenText = SLOTS.map((_, k) => {
      const it = [...this.items.values()].find((x) => x.slot === k);
      if (!it) return `${k + 1}: empty`;
      if (it.bake >= BAKE_BURNT) return `${k + 1}: BURNT!`;
      if (it.bake >= BAKE_DONE) return `${k + 1}: READY!`;
      return `${k + 1}: ${Math.round(it.bake * 100)}%`;
    });
    this.ovenLabel.set(`OVEN\n${ovenText.join('   ')}`);
    this.slotGlow.forEach((g, k) => {
      const it = [...this.items.values()].find((x) => x.slot === k);
      g.material.color.set(!it ? 0x553311 : it.bake >= BAKE_BURNT ? 0x333333 : it.bake >= BAKE_DONE ? 0x7dff8a : 0xff7a1a);
    });
  }

  update(dt) {
    smoothMove(this.app, dt, { speed: 1.6, clamp: (p) => { p.x = THREE.MathUtils.clamp(p.x, -1.5, 1.5); p.z = THREE.MathUtils.clamp(p.z, -0.25, 0.7); } });
    snapTurn(this.app, this.turn);
    this.updateHands(dt);
    if (this.isHost) {
      if (this.phase === 'shift') this.hostSim(dt);
      else for (const it of this.items.values()) if (!it.held) it.p[1] = Math.max(it.p[1], surfaceY(it.p[0], it.p[2]) + halfH(it));
      // Guest-held bottles squeeze sauce on the host's side.
      for (const it of this.items.values()) if (it.kind === 'bottle' && it.held === 'guest' && it.squeezing) this.squeezeSauce(it, dt);
      this.sendAcc += dt;
      if (this.sendAcc >= 0.1) { this.sendAcc = 0; this.sendState(); }
    }
    this.syncViews(dt);
    this.botMesh.visible = this.botOn;
    this.botMesh.position.set(...this.bot.p);
    this.botMesh.rotation.y += dt;
    // Size readout while stretching.
    const st = this.stretch && this.items.get(this.stretch.id);
    this.sizeLabel.mesh.visible = !!st;
    if (st) {
      const k = sizeOf(st.size);
      this.sizeLabel.set(k ? `${k} ✓` : `${Math.round(st.size * 100)} cm`, k ? '#7dff8a' : '#ffffff');
      this.sizeLabel.mesh.position.set(st.p[0], st.p[1] + 0.18, st.p[2]);
      this.sizeLabel.mesh.lookAt(this.app.camera.getWorldPosition(_v));
    }
    this.refreshBoards();
  }
}
