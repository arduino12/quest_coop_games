import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { glowMat, starfield } from '../../core/env.js';
import { GrabMove } from '../../core/grabmove.js';
import { COLORS } from '../../config.js';
import { TOP, LEDGES, WALL_W, WALL_X, WALL_Z, generateHolds, floorBelow, rockY } from './logic.js';

const GRAVITY = 9.8;
const HOLD_REACH = 0.13;
const ROCK_R = 0.2;
const ROCK_EVERY = 5;
const BEST_KEY = 'qcg-climb-best';
const _v = new THREE.Vector3();

// Each player owns their own climber (the avatar shows them to the other); the host starts the race,
// drops the rocks and decides who rang the bell first. Rocks are judged by the climber they fall on.
export class Climb extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.otherSide = app.otherSide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.phase = 'wait'; // wait -> count -> race -> over
    this.count = 0;
    this.raceT = 0;
    this.move = new GrabMove(app);
    this.gripping = [false, false];
    this.vy = 0;
    this.rocks = new Map();
    this.nextRock = 1;
    this.rockAcc = 0;
    this.usedButtons = new Set();
    this.knockT = 0;
    this.winner = null;
    this.best = Number(localStorage.getItem(BEST_KEY) || 0);
    this.wallX = WALL_X[this.mySide];

    this.buildWorld();
    this.app.setRig(this.wallX, 0, 0, 0);
    this.move.prev.copy(app.rig.position);
    this.buildHud();
    if (this.isHost) {
      this.seed = Math.floor(Math.random() * 1e9);
      this.buildHolds(this.seed);
      // With a partner, the countdown starts when they have joined, so nobody gets a head start.
      if (this.solo) this.startRace(this.seed);
    } else app.sendGame('join');
  }

  buildWorld() {
    const root = this.root;
    this.app.scene.background = new THREE.Color(0x0e1630);
    this.app.scene.fog = new THREE.Fog(0x0e1630, 25, 70);
    root.add(starfield(800));
    root.add(new THREE.HemisphereLight(0xcfd8ff, 0x3a3020, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(3, 20, 8);
    root.add(sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 40), new THREE.MeshLambertMaterial({ color: 0x2a3a2a }));
    ground.rotation.x = -Math.PI / 2;
    root.add(ground);
    this.walls = {};
    for (const side of ['host', 'guest']) {
      const x = WALL_X[side];
      const rock = new THREE.Mesh(new THREE.BoxGeometry(WALL_W, TOP + 1.5, 0.4), new THREE.MeshLambertMaterial({ color: 0x6a5e52, flatShading: true }));
      rock.position.set(x, (TOP + 1.5) / 2, WALL_Z - 0.2);
      root.add(rock);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(0.04, TOP + 1.5, 0.05), glowMat(COLORS[side]));
      trim.position.set(x + (side === 'host' ? -WALL_W / 2 : WALL_W / 2), (TOP + 1.5) / 2, WALL_Z);
      root.add(trim);
      for (const y of LEDGES) {
        const ledge = new THREE.Mesh(new THREE.BoxGeometry(WALL_W, 0.05, 0.6), new THREE.MeshLambertMaterial({ color: 0x8892a8, transparent: true, opacity: 0.55 }));
        ledge.position.set(x, y - 0.025, WALL_Z + 0.3);
        root.add(ledge);
        const tag = new Label(`${y} m`, { w: 0.3, h: 0.09, color: '#ffffff' });
        tag.mesh.position.set(x - 0.7, y + 0.35, WALL_Z + 0.01);
        root.add(tag.mesh);
      }
      const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.16, 0.22, 20, 1, true), new THREE.MeshLambertMaterial({ color: 0xffcc33, emissive: 0x553300, side: THREE.DoubleSide }));
      bell.position.set(x, TOP + 0.35, WALL_Z + 0.25);
      root.add(bell);
      this.walls[side] = { x, bell, holds: [], buttons: [] };
    }
    // Rock buttons: one per ledge on each wall, drops rocks on the OTHER wall.
    for (const side of ['host', 'guest']) {
      for (const y of LEDGES) {
        const btn = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), glowMat(0xff3322));
        btn.position.set(WALL_X[side] + 0.7, y, WALL_Z + 0.45);
        this.root.add(btn);
        this.walls[side].buttons.push({ y, mesh: btn });
      }
    }
    this.holdGeo = new THREE.DodecahedronGeometry(0.045, 0);
    this.rockGeo = new THREE.DodecahedronGeometry(ROCK_R, 0);
    this.rockMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a, flatShading: true });
    this.fade = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false }));
    this.fade.renderOrder = 998;
    this.attach(this.app.camera, this.fade);
  }

  buildHolds(seed) {
    const holds = generateHolds(seed);
    const colors = [0xff6b6b, 0xffd93d, 0x6bcBff, 0x7dff8a, 0xc58bff];
    for (const side of ['host', 'guest']) {
      const w = this.walls[side];
      for (const m of w.holds) this.root.remove(m);
      w.holds = holds.map(([hx, hy], i) => {
        const m = new THREE.Mesh(this.holdGeo, new THREE.MeshLambertMaterial({ color: colors[i % colors.length], flatShading: true }));
        m.position.set(w.x + hx, hy, WALL_Z + 0.03);
        this.root.add(m);
        return m;
      });
    }
  }

  buildHud() {
    this.hud = new Label('', { w: 0.9, h: 0.16, res: 768, size: 0.6, bg: 'rgba(5,8,20,0.7)' });
    this.hud.mesh.position.set(0, 2.05, -0.25);
    this.hud.mesh.rotation.x = 0.3;
    this.attach(this.app.rig, this.hud.mesh);
  }

  // ---------- race flow ----------

  startRace(seed) {
    this.seed = seed;
    this.buildHolds(seed);
    this.phase = 'count';
    this.count = 3.5;
    this.raceT = 0;
    this.winner = null;
    this.usedButtons.clear();
    this.app.toast('Climb to the bell! Squeeze to grip holds.\nHit the red buttons on ledges to drop rocks on your rival.', 4);
    if (this.isHost && !this.solo) this.app.sendGame('go', { seed });
  }

  finish(winner) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.winner = winner;
    if (this.solo && (!this.best || this.raceT < this.best)) {
      this.best = Math.round(this.raceT * 10) / 10;
      localStorage.setItem(BEST_KEY, String(this.best));
    }
    if (this.isHost && !this.solo) this.app.sendGame('winner', { winner, time: this.raceT });
    this.app.sfx.goal(winner === this.mySide || this.solo);
    this.showOver();
  }

  // ---------- climbing ----------

  myHeight() {
    return this.app.camera.getWorldPosition(_v).y;
  }

  standingOn() {
    const y = this.app.rig.position.y;
    const f = floorBelow(y);
    return Math.abs(y - f) < 0.02 ? f : null;
  }

  updateClimb(dt) {
    const app = this.app;
    const wall = this.walls[this.mySide];
    const racing = this.phase === 'race' && this.knockT <= 0;
    app.hands.forEach((hand, i) => {
      if (!hand.connected) return;
      if (hand.state.squeeze.down && racing) {
        const hold = wall.holds.find((m) => m.position.distanceTo(hand.pos) < HOLD_REACH);
        if (hold) {
          this.gripping[i] = true;
          this.move.grab(i, hand.pos);
          this.vy = 0;
          hand.pulse(0.35, 25);
          app.sfx.tone({ f: 300, dur: 0.05, type: 'triangle', vol: 0.1 });
        }
      }
      if (this.gripping[i] && !hand.state.squeeze.pressed) {
        this.gripping[i] = false;
        this.move.release(i);
        const other = 1 - i;
        if (this.gripping[other]) this.move.grab(other, app.hands[other].pos);
      }
      // Ring the bell / press rock buttons.
      if (this.phase === 'race' && hand.pos.distanceTo(wall.bell.position) < 0.2) this.ringBell();
      for (const b of wall.buttons) {
        if (!this.usedButtons.has(b.y) && this.phase === 'race' && hand.pos.distanceTo(b.mesh.position) < 0.12) this.pressButton(b);
      }
    });

    const rig = app.rig;
    const prevY = rig.position.y;
    if (!this.move.holding && this.standingOn() === null) {
      this.vy = Math.max(-14, this.vy - GRAVITY * dt);
      rig.position.y += this.vy * dt;
      const f = floorBelow(prevY);
      if (rig.position.y <= f) {
        rig.position.y = f;
        if (this.vy < -4) {
          app.sfx.thunk(null);
          for (const h of app.hands) h.pulse(0.6, 80);
        }
        this.vy = 0;
      }
    }
    this.move.update(dt);
    rig.position.x = THREE.MathUtils.clamp(rig.position.x, this.wallX - 0.9, this.wallX + 0.9);
    rig.position.z = THREE.MathUtils.clamp(rig.position.z, -0.2, 0.6);
    rig.position.y = Math.max(0, rig.position.y);
    this.fade.material.opacity = THREE.MathUtils.clamp((-this.vy - 3) / 10, 0, 0.85);
    this.fade.visible = this.fade.material.opacity > 0.01;
  }

  ringBell() {
    this.app.sfx.powerup();
    if (this.solo) this.finish(this.mySide);
    else if (this.isHost) this.finish(this.mySide);
    else this.app.sendGame('bell', { time: this.raceT });
    this.phase = 'over';
  }

  pressButton(b) {
    this.usedButtons.add(b.y);
    b.mesh.material.color.set(0x444444);
    this.app.sfx.tone({ f: 200, f2: 90, dur: 0.3, type: 'square', vol: 0.15 });
    this.app.toast('Rocks incoming on your rival!', 1.5);
    if (this.isHost) this.dropRocks(this.otherSide, 3);
    else this.app.sendGame('button');
  }

  // ---------- rocks ----------

  dropRocks(side, n) {
    for (let i = 0; i < n; i++) {
      const rock = { id: this.nextRock++, side, x: -0.75 + Math.random() * 1.5, delay: i * 0.5 };
      this.spawnRock(rock);
      if (!this.solo) this.app.sendGame('rock', rock);
    }
  }

  spawnRock(r) {
    const mesh = new THREE.Mesh(this.rockGeo, this.rockMat);
    mesh.position.set(WALL_X[r.side] + r.x, rockY(0), WALL_Z + 0.3);
    this.root.add(mesh);
    this.rocks.set(r.id, { ...r, mesh, age: -r.delay });
  }

  updateRocks(dt) {
    if (this.isHost && this.phase === 'race') {
      this.rockAcc += dt;
      if (this.rockAcc >= ROCK_EVERY) {
        this.rockAcc = 0;
        this.dropRocks('host', 1);
        if (!this.solo) this.dropRocks('guest', 1);
      }
    }
    const head = this.app.camera.getWorldPosition(new THREE.Vector3());
    for (const [id, r] of this.rocks) {
      r.age += dt;
      const y = rockY(Math.max(0, r.age));
      r.mesh.position.y = y;
      r.mesh.rotation.x += dt * 3;
      if (y < -1) {
        this.root.remove(r.mesh);
        this.rocks.delete(id);
        continue;
      }
      if (r.side !== this.mySide || this.knockT > 0 || this.phase !== 'race') continue;
      const hitHead = r.mesh.position.distanceTo(head) < ROCK_R + 0.2;
      const hitHand = this.app.hands.some((h, i) => this.gripping[i] && r.mesh.position.distanceTo(h.pos) < ROCK_R + 0.1);
      if (hitHead || hitHand) this.knockedOff();
    }
  }

  knockedOff() {
    this.knockT = 1.0;
    this.gripping = [false, false];
    this.move.release();
    this.app.sfx.boom(null, false);
    for (const h of this.app.hands) h.pulse(1, 200);
    this.app.toast('Hit by a rock!', 1.5);
    if (!this.solo) this.app.sendGame('ouch');
  }

  // ---------- networking ----------

  onNet(k, d) {
    switch (k) {
      case 'join':
        if (this.isHost) this.startRace(this.seed);
        break;
      case 'go':
        if (!this.isHost) this.startRace(d.seed);
        break;
      case 'rock':
        if (!this.rocks.has(d.id)) this.spawnRock(d);
        break;
      case 'button':
        if (this.isHost) this.dropRocks('host', 3);
        break;
      case 'bell':
        if (this.isHost && this.winner === null) this.finish(this.otherSide);
        break;
      case 'winner':
        if (!this.isHost) {
          this.phase = 'race'; // allow finish() to run
          this.finish(d.winner);
        }
        break;
      case 'ouch':
        this.app.sfx.thunk(null);
        break;
      case 'rematch':
        if (this.isHost) this.app.requestGame('climb');
        break;
      default:
    }
  }

  // ---------- frame ----------

  update(dt) {
    if (this.phase === 'count') {
      const before = Math.ceil(this.count);
      this.count -= dt;
      if (Math.ceil(this.count) !== before && this.count > 0) this.app.sfx.tone({ f: 600, dur: 0.12, type: 'square', vol: 0.12 });
      if (this.count <= 0) {
        this.phase = 'race';
        this.app.sfx.tone({ f: 1200, dur: 0.3, type: 'square', vol: 0.15 });
      }
    } else if (this.phase === 'race') this.raceT += dt;
    this.knockT -= dt;
    this.updateClimb(dt);
    this.updateRocks(dt);

    const mine = Math.max(0, this.myHeight() - 1.5);
    let text;
    if (this.phase === 'wait') text = 'Waiting for your rival…';
    else if (this.phase === 'count') text = this.count > 0.5 ? `READY… ${Math.ceil(this.count - 0.5)}` : 'GO!';
    else if (this.solo) text = `${mine.toFixed(1)} m  ·  ${this.raceT.toFixed(1)} s${this.best ? `  ·  BEST ${this.best} s` : ''}`;
    else {
      const theirs = Math.max(0, this.app.avatar.head.position.y - 1.5);
      text = `YOU ${mine.toFixed(1)} m   ·   THEM ${theirs.toFixed(1)} m`;
    }
    if (this.phase !== 'over') this.hud.set(text);
  }

  showOver() {
    if (!this.overPanel) {
      this.overPanel = this.app.ui.add(new Panel({ w: 1.0, h: 0.62, cols: 2 }));
      this.attach(this.app.rig, this.overPanel.mesh);
    }
    const won = this.solo || this.winner === this.mySide;
    this.overPanel.set({
      title: this.solo ? `TOP IN ${this.raceT.toFixed(1)} s` : won ? 'YOU RANG FIRST!' : 'THEY WON THE RACE',
      accent: won ? '#7dff8a' : '#ff6b6b',
      lines: [this.solo ? `Best: ${this.best} s` : 'Rematch?'],
      buttons: [
        { label: 'Again', onClick: () => (this.isHost ? this.app.requestGame('climb') : this.app.sendGame('rematch')) },
        { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
      ],
    });
    this.overPanel.mesh.position.set(0, 1.5, -0.22);
    this.overPanel.mesh.visible = true;
    this.hud.set(won ? 'WINNER!' : 'Race over');
  }
}
