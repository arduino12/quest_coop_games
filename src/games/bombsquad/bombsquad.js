import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { glowMat, lineMat } from '../../core/env.js';
import {
  generateBomb, initialState, applyAction, keypadOrder, MANUAL, MAX_STRIKES,
} from './logic.js';

const EXPERT_ROOM = new THREE.Vector3(40, 0, 0);
const BOMB_POS = new THREE.Vector3(0, 1.0, -0.5);
const SLOT_X = [-0.23, 0, 0.23];
const SLOT_Y = [0.07, -0.13];
const WIRE_HEX = { red: 0xe0312b, blue: 0x2b6fe0, yellow: 0xf2d31b, white: 0xf2f2f2, black: 0x1a1a1a };
const BUTTON_HEX = { red: 0xd02828, blue: 0x2858d0, yellow: 0xe8c81c, white: 0xe8e8e8 };
const STRIP_HEX = { blue: 0x3388ff, yellow: 0xffdd22, red: 0xff3322, white: 0xffffff };
const PAGES = ['Basics', 'Wires', 'Button', 'Keypad', 'Password'];
const mmss = (s) => {
  const t = Math.max(0, Math.ceil(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const _ray = new THREE.Raycaster();

// Asymmetric co-op: the defuser has the bomb, the expert has the manual, in separate rooms.
// The host owns the timer, strikes and module state; the defuser's actions go to the host.
export class BombSquad extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.roles = { defuser: 'host', expert: this.solo ? 'host' : 'guest' };
    this.phase = 'brief'; // brief -> armed -> defused | exploded
    this.level = 1;
    this.bomb = null;
    this.state = null;
    this.strikes = 0;
    this.timeLeft = 0;
    this.page = 'Basics';
    this.targets = []; // interactive meshes on the bomb
    this.hover = [null, null];
    this.hold = null; // { hand, start }
    this.pw = [0, 0, 0, 0, 0];
    this.tickAcc = 0;
    this.sendAcc = 0;
    this.flash = 0;

    app.avatar.setVisible(false); // you can't see each other: different rooms
    this.buildRooms();
    this.buildPointers();
    this.placeRig();
    this.refreshPanels();
    if (!this.isHost) app.sendGame('join');
  }

  get isDefuser() { return this.roles.defuser === this.mySide; }
  get isExpert() { return this.roles.expert === this.mySide; }

  // ---------- rooms ----------

  buildRooms() {
    const root = this.root;
    this.app.scene.background = new THREE.Color(0x0b0d12);
    root.add(new THREE.HemisphereLight(0xdfe6ff, 0x302820, 0.9));
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3b4a42, side: THREE.BackSide });
    const room = (center, color) => {
      const box = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 5), wallMat.clone());
      box.material.color.set(color);
      box.position.set(center.x, 1.5, center.z);
      root.add(box);
      const lamp = new THREE.PointLight(0xfff0d8, 2, 8, 1.5);
      lamp.position.set(center.x, 2.7, center.z - 0.3);
      root.add(lamp);
    };
    room(new THREE.Vector3(0, 0, 0), 0x3b4a42);
    room(EXPERT_ROOM, 0x3e3a52);

    // Defuser's table.
    const wood = new THREE.MeshLambertMaterial({ color: 0x5a4632 });
    const table = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.7), wood);
    table.position.set(0, 0.75, -0.55);
    root.add(table);
    for (const [x, z] of [[-0.55, -0.85], [0.55, -0.85], [-0.55, -0.25], [0.55, -0.25]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 0.05), wood);
      leg.position.set(x, 0.375, z);
      root.add(leg);
    }

    // Expert's manual screen, a status line and the brief/result panels.
    this.manual = this.app.ui.add(new Panel({ w: 2.5, h: 2.0, res: 1280, accent: '#ffb347', cols: 5, lineScale: 0.7 }));
    this.status = new Label('', { w: 1.6, h: 0.14, res: 1024, size: 0.6, color: '#ffb347' });
    this.panel = this.app.ui.add(new Panel({ w: 1.2, h: 0.8, accent: '#7dff8a', cols: 2 }));
    root.add(this.manual.mesh, this.status.mesh, this.panel.mesh);
    this.placeManual();
  }

  placeManual() {
    if (this.solo) {
      // Alone: the manual hangs on the wall to your right.
      this.manual.mesh.position.set(1.6, 1.55, -0.7);
      this.manual.mesh.rotation.y = -1.15;
      this.status.mesh.position.set(1.6, 2.65, -0.7);
      this.status.mesh.rotation.y = -1.15;
    } else {
      this.manual.mesh.position.set(EXPERT_ROOM.x, 1.5, EXPERT_ROOM.z - 1.4);
      this.manual.mesh.rotation.y = 0;
      this.status.mesh.position.set(EXPERT_ROOM.x, 2.65, EXPERT_ROOM.z - 1.4);
      this.status.mesh.rotation.y = 0;
    }
  }

  placeRig() {
    if (this.isDefuser) this.app.setRig(0, 0, 0.1, 0);
    else this.app.setRig(EXPERT_ROOM.x, 0, EXPERT_ROOM.z + 0.3, 0);
    const p = this.isDefuser ? new THREE.Vector3(0, 1.45, -1.2) : new THREE.Vector3(EXPERT_ROOM.x - 1.25, 1.45, EXPERT_ROOM.z - 0.9);
    this.panel.mesh.position.copy(p);
    this.panel.mesh.rotation.y = this.isDefuser ? 0 : 0.5;
  }

  buildPointers() {
    this.pointers = this.app.hands.map((hand) => {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        lineMat(0xffee88, 0.8),
      );
      line.visible = false;
      return this.attach(hand.ray, line);
    });
  }

  // ---------- the bomb ----------

  buildBomb() {
    if (this.bombGroup) this.root.remove(this.bombGroup);
    this.targets = [];
    const g = (this.bombGroup = new THREE.Group());
    g.position.copy(BOMB_POS);
    g.rotation.x = -0.55;
    this.root.add(g);
    const metal = new THREE.MeshLambertMaterial({ color: 0x2c2f36 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.56, 0.12), metal);
    body.position.z = -0.065;
    g.add(body);
    const trim = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), lineMat(0xff5533, 0.6));
    trim.position.copy(body.position);
    g.add(trim);

    this.timerLabel = new Label('00:00', { w: 0.2, h: 0.07, color: '#ff3b30', bg: '#120404', size: 0.85 });
    this.timerLabel.mesh.position.set(-0.22, 0.215, 0.003);
    this.strikeLabel = new Label('', { w: 0.14, h: 0.06, color: '#ff3b30', size: 0.8 });
    this.strikeLabel.mesh.position.set(0.0, 0.215, 0.003);
    this.serialLabel = new Label(`SERIAL ${this.bomb.serial}`, { w: 0.24, h: 0.05, color: '#e8e8e8', bg: '#202228', size: 0.7 });
    this.serialLabel.mesh.position.set(0.24, 0.215, 0.003);
    g.add(this.timerLabel.mesh, this.strikeLabel.mesh, this.serialLabel.mesh);

    this.mods = this.bomb.modules.map((m, i) => {
      const slot = new THREE.Group();
      slot.position.set(SLOT_X[i % 3], SLOT_Y[Math.floor(i / 3)], 0);
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.17), new THREE.MeshLambertMaterial({ color: 0x4a4e58 }));
      slot.add(plate);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), glowMat(0xff2222));
      led.position.set(0.085, 0.07, 0.008);
      slot.add(led);
      g.add(slot);
      const view = { slot, led, parts: {} };
      if (m.type === 'wires') this.buildWires(m, i, view);
      else if (m.type === 'button') this.buildButton(m, i, view);
      else if (m.type === 'keypad') this.buildKeypad(m, i, view);
      else this.buildPassword(m, i, view);
      return view;
    });
  }

  target(mesh, m, kind, index = 0) {
    mesh.userData.hit = { m, kind, index };
    this.targets.push(mesh);
    return mesh;
  }

  buildWires(m, i, view) {
    const n = m.wires.length;
    view.parts.wires = m.wires.map((color, k) => {
      const y = 0.055 - (k * 0.11) / Math.max(1, n - 1);
      const mat = new THREE.MeshLambertMaterial({ color: WIRE_HEX[color] });
      const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.15, 8), mat);
      wire.rotation.z = Math.PI / 2;
      wire.position.set(0, y, 0.012);
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.15, 6), new THREE.MeshBasicMaterial({ visible: false }));
      hit.rotation.z = Math.PI / 2;
      hit.position.copy(wire.position);
      const stubs = [-1, 1].map((s) => {
        const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.05, 8), mat);
        stub.rotation.z = Math.PI / 2;
        stub.position.set(s * 0.05, y, 0.012);
        stub.visible = false;
        return stub;
      });
      view.slot.add(wire, hit, ...stubs);
      this.target(hit, i, 'wire', k);
      return { wire, hit, stubs };
    });
  }

  buildButton(m, i, view) {
    const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 24), new THREE.MeshLambertMaterial({ color: BUTTON_HEX[m.color] }));
    btn.rotation.x = Math.PI / 2;
    btn.position.set(-0.015, -0.005, 0.016);
    const label = new Label(m.label, { w: 0.08, h: 0.03, color: m.color === 'white' || m.color === 'yellow' ? '#111' : '#fff', size: 0.85 });
    label.mesh.position.set(-0.015, -0.005, 0.032);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.12, 0.01), new THREE.MeshBasicMaterial({ color: 0x222222 }));
    strip.position.set(0.07, -0.005, 0.006);
    view.slot.add(btn, label.mesh, strip);
    this.target(btn, i, 'button');
    view.parts = { btn, strip };
  }

  buildKeypad(m, i, view) {
    view.parts.keys = m.symbols.map((sym, k) => {
      const key = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.015), new THREE.MeshLambertMaterial({ color: 0xd8d2c0 }));
      key.position.set(k % 2 ? 0.042 : -0.042, k < 2 ? 0.032 : -0.038, 0.008);
      const label = new Label(sym, { w: 0.05, h: 0.05, color: '#111', size: 0.85 });
      label.mesh.position.set(key.position.x, key.position.y, 0.0165);
      view.slot.add(key, label.mesh);
      this.target(key, i, 'key', k);
      return key;
    });
  }

  buildPassword(m, i, view) {
    const arrowGeo = new THREE.ConeGeometry(0.011, 0.018, 3);
    const arrowMat = new THREE.MeshLambertMaterial({ color: 0xcfd6e6 });
    view.parts.letters = m.columns.map((col, k) => {
      const x = -0.08 + k * 0.04;
      const letter = new Label(col[0], { w: 0.034, h: 0.045, color: '#7dff8a', bg: '#06140a', size: 0.85 });
      letter.mesh.position.set(x, 0.005, 0.004);
      const up = new THREE.Mesh(arrowGeo, arrowMat);
      up.position.set(x, 0.048, 0.01);
      const down = new THREE.Mesh(arrowGeo, arrowMat);
      down.position.set(x, -0.038, 0.01);
      down.rotation.z = Math.PI;
      view.slot.add(letter.mesh, up, down);
      this.target(up, i, 'up', k);
      this.target(down, i, 'down', k);
      return letter;
    });
    const ok = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.022, 0.012), new THREE.MeshLambertMaterial({ color: 0x3a8a4a }));
    ok.position.set(0.055, -0.07, 0.008);
    const okLabel = new Label('OK', { w: 0.04, h: 0.02, size: 0.9 });
    okLabel.mesh.position.set(0.055, -0.07, 0.0145);
    view.slot.add(ok, okLabel.mesh);
    this.target(ok, i, 'ok');
  }

  // ---------- defuser input ----------

  updateDefuser(dt) {
    const app = this.app;
    const armed = this.phase === 'armed' && this.isDefuser;
    app.hands.forEach((hand, h) => {
      const line = this.pointers[h];
      this.hover[h] = null;
      if (!armed || !hand.connected || app.ui.captures(hand)) { line.visible = false; return; }
      _ray.set(hand.rayOrigin, hand.dir);
      const hit = _ray.intersectObjects(this.targets, false)[0];
      line.visible = !!hit && hit.distance < 2;
      if (!line.visible) return;
      line.scale.z = hit.distance;
      this.hover[h] = hit.object.userData.hit;
      if (hand.state.trigger.down) this.press(hit.object.userData.hit, h);
    });
    if (this.hold) {
      const hand = app.hands[this.hold.hand];
      if (!hand.state.trigger.pressed || this.phase !== 'armed') {
        const held = app.time - this.hold.start;
        const digit = Number(mmss(this.timeLeft).slice(-1));
        const m = this.hold.m;
        this.hold = null;
        this.setStrip(m, null);
        this.act(m, { held, digit });
      }
    }
  }

  press(hit, hand) {
    const { m, kind, index } = hit;
    const st = this.state[m];
    if (st.solved) return;
    this.app.hands[hand].pulse(0.4, 25);
    this.app.sfx.click();
    if (kind === 'wire') {
      if (st.cut.includes(index)) return;
      this.showCut(m, index);
      this.act(m, { cut: index });
    } else if (kind === 'button') {
      this.hold = { m, hand, start: this.app.time };
      this.setStrip(m, this.bomb.modules[m].strip);
    } else if (kind === 'key') this.act(m, { press: this.bomb.modules[m].symbols[index] });
    else if (kind === 'up' || kind === 'down') {
      const cols = this.bomb.modules[m].columns;
      this.pw[index] = (this.pw[index] + (kind === 'up' ? 1 : cols[index].length - 1)) % cols[index].length;
      this.mods[m].parts.letters[index].set(cols[index][this.pw[index]]);
    } else if (kind === 'ok') {
      const cols = this.bomb.modules[m].columns;
      this.act(m, { word: cols.map((c, k) => c[this.pw[k]]).join('') });
    }
  }

  act(m, action) {
    if (this.isHost) this.resolve(m, action);
    else this.app.sendGame('act', { m, a: action });
  }

  showCut(m, k) {
    const w = this.mods[m].parts.wires[k];
    w.wire.visible = false;
    w.stubs.forEach((s) => { s.visible = true; });
  }

  setStrip(m, color) {
    const strip = this.mods?.[m]?.parts.strip;
    if (strip) strip.material.color.set(color ? STRIP_HEX[color] : 0x222222);
  }

  // ---------- host rules ----------

  resolve(m, action) {
    if (this.phase !== 'armed') return;
    const r = applyAction(this.bomb, this.state, m, action);
    if (r === 'strike') this.strikes++;
    const done = this.state.every((s) => s.solved);
    if (this.strikes >= MAX_STRIKES) this.phase = 'exploded';
    else if (done) this.phase = 'defused';
    this.onResult(m, r);
    this.broadcast(m, r);
    if (this.phase !== 'armed') this.onEnd();
  }

  broadcast(m = -1, r = null) {
    if (this.solo) return;
    this.app.sendGame('state', { t: this.timeLeft, strikes: this.strikes, st: this.state, phase: this.phase, m, r });
  }

  onResult(m, r) {
    const sfx = this.app.sfx;
    if (r === 'strike') {
      sfx.tone({ f: 140, dur: 0.5, type: 'sawtooth', vol: 0.3 });
      this.flash = 0.5;
      for (const h of this.app.hands) h.pulse(1, 200);
    } else if (r === 'solve') sfx.powerup();
    else if (r === 'ok') sfx.tone({ f: 900, dur: 0.06, type: 'square', vol: 0.06 });
    this.refreshBomb();
  }

  startBomb(level, seed) {
    this.level = level;
    this.bomb = generateBomb(level, seed);
    this.state = initialState(this.bomb);
    this.strikes = 0;
    this.timeLeft = this.bomb.time;
    this.pw = [0, 0, 0, 0, 0];
    this.hold = null;
    this.phase = 'armed';
    this.buildBomb();
    this.refreshBomb();
    this.refreshPanels();
    this.placeRig();
    this.app.toast(this.isDefuser ? 'Describe the bomb to your expert!' : 'Ask the defuser what they see!', 3);
  }

  arm() {
    if (!this.isHost) { this.app.sendGame('start'); return; }
    const seed = Math.floor(Math.random() * 1e9);
    const level = this.phase === 'defused' ? this.level + 1 : this.phase === 'brief' ? 1 : this.level;
    this.app.sendGame('arm', { seed, level, roles: this.roles });
    this.startBomb(level, seed);
  }

  onEnd() {
    const sfx = this.app.sfx;
    if (this.phase === 'defused') {
      sfx.goal(true);
      this.app.toast(`BOMB DEFUSED with ${mmss(this.timeLeft)} left!`, 4);
    } else {
      sfx.boom(this.bombGroup ? BOMB_POS : null, true);
      this.app.particles.burst(BOMB_POS, 0xffaa33, 150, 5, 1.4, 2);
      this.flash = 1.2;
      this.app.toast(this.timeLeft <= 0 ? 'Time ran out… BOOM' : 'Third strike… BOOM', 4);
    }
    this.refreshPanels();
  }

  swapRoles() {
    if (this.solo || this.phase === 'armed') return;
    if (!this.isHost) { this.app.sendGame('swap'); return; }
    this.roles = { defuser: this.roles.expert, expert: this.roles.defuser };
    this.app.sendGame('roles', { roles: this.roles });
    this.placeRig();
    this.refreshPanels();
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
        this.refreshPanels();
        break;
      case 'swap':
        if (this.isHost) this.swapRoles();
        break;
      case 'start':
        if (this.isHost && this.phase !== 'armed') this.arm();
        break;
      case 'arm':
        if (this.isHost) return;
        this.roles = d.roles;
        this.startBomb(d.level, d.seed);
        break;
      case 'act':
        if (this.isHost) this.resolve(d.m, d.a);
        break;
      case 'state': {
        if (this.isHost || !this.bomb) return;
        const before = this.phase;
        this.timeLeft = d.t;
        this.strikes = d.strikes;
        this.state = d.st;
        this.phase = d.phase;
        if (d.r) this.onResult(d.m, d.r);
        else this.refreshBomb();
        if (before === 'armed' && this.phase !== 'armed') this.onEnd();
        break;
      }
      default:
    }
  }

  // ---------- drawing ----------

  refreshBomb() {
    if (!this.bomb || !this.mods) return;
    this.state.forEach((st, m) => {
      const view = this.mods[m];
      view.led.material.color.set(st.solved ? 0x22ff44 : 0xff2222);
      const mod = this.bomb.modules[m];
      if (mod.type === 'wires') st.cut.forEach((k) => this.showCut(m, k));
      if (mod.type === 'keypad') {
        const done = keypadOrder(mod.symbols).slice(0, st.progress);
        view.parts.keys.forEach((key, k) => key.material.color.set(done.includes(mod.symbols[k]) ? 0x7dff8a : 0xd8d2c0));
      }
    });
    this.strikeLabel.set('✖'.repeat(this.strikes) + '·'.repeat(Math.max(0, MAX_STRIKES - 1 - this.strikes)) || ' ');
  }

  refreshPanels() {
    const p = this.panel;
    const you = this.solo ? 'DEFUSER (manual on your right)' : this.isDefuser ? 'DEFUSER' : 'EXPERT';
    if (this.phase === 'brief') {
      p.set({
        title: 'BOMB SQUAD',
        accent: '#7dff8a',
        lines: [
          `You are the ${you}.`,
          this.solo ? 'Read the manual on the wall and defuse the bomb on the table.' : 'Defuser: describe the bomb. Expert: read the manual and give instructions. Use voice chat!',
          'Point and pull the trigger to cut wires and press buttons.',
        ],
        buttons: [
          { label: 'Swap roles', enabled: !this.solo, onClick: () => this.swapRoles() },
          { label: 'Arm the bomb', onClick: () => this.arm() },
        ],
      });
      p.mesh.visible = true;
    } else if (this.phase === 'armed') {
      p.mesh.visible = false;
    } else {
      const won = this.phase === 'defused';
      p.set({
        title: won ? `DEFUSED! (bomb ${this.level})` : 'BOOM!',
        accent: won ? '#7dff8a' : '#ff6b6b',
        lines: [won ? 'Next bomb: more modules, more pressure.' : `You were on bomb ${this.level}. Try again!`],
        buttons: [
          { label: won ? 'Next bomb' : 'Try again', onClick: () => this.arm() },
          { label: 'Swap roles', enabled: !this.solo, onClick: () => this.swapRoles() },
          { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
        ],
        cols: 3,
      });
      p.mesh.visible = true;
    }
    this.refreshManual();
  }

  refreshManual() {
    const showManual = this.isExpert || this.solo;
    this.manual.mesh.visible = this.status.mesh.visible = showManual;
    this.manual.set({
      title: `BOMB DEFUSAL MANUAL · ${this.page.toUpperCase()}`,
      lines: MANUAL[this.page],
      buttons: PAGES.map((pg) => ({ label: pg, accent: pg === this.page ? '#7dff8a' : '#ffb347', onClick: () => { this.page = pg; this.refreshManual(); } })),
    });
  }

  update(dt) {
    if (this.phase === 'armed') {
      this.timeLeft -= dt;
      if (this.isHost) {
        this.sendAcc += dt;
        if (this.sendAcc >= 1) { this.sendAcc = 0; this.broadcast(); }
        if (this.timeLeft <= 0) {
          this.timeLeft = 0;
          this.phase = 'exploded';
          this.broadcast();
          this.onEnd();
        }
      }
      // Ticking, faster near the end.
      this.tickAcc -= dt;
      if (this.tickAcc <= 0) {
        this.tickAcc = this.timeLeft < 30 ? 0.5 : 1;
        if (this.isDefuser) this.app.sfx.tone({ f: this.timeLeft < 30 ? 1500 : 1100, dur: 0.04, type: 'square', vol: 0.05, pos: BOMB_POS });
      }
    }
    this.updateDefuser(dt);
    if (this.bomb) this.timerLabel?.set(mmss(this.timeLeft));
    this.status.set(this.bomb && this.phase === 'armed'
      ? `TIME ${mmss(this.timeLeft)}   ·   STRIKES ${this.strikes}/${MAX_STRIKES - 1}   ·   ${this.state.filter((s) => s.solved).length}/${this.state.length} MODULES DONE`
      : 'Waiting for the bomb…');
    if (this.bombGroup) {
      this.flash = Math.max(0, this.flash - dt);
      this.bombGroup.position.x = BOMB_POS.x + (this.flash > 0 && this.phase === 'armed' ? Math.sin(this.app.time * 90) * 0.004 : 0);
    }
  }

  dispose() {
    this.app.avatar.setVisible(this.app.net.connected);
    super.dispose();
  }
}
