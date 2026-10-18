import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { glowMat, lineMat, starfield } from '../../core/env.js';
import { GrabMove } from '../../core/grabmove.js';
import { sphereHitsBody } from '../../core/geom.js';
import { r2 } from '../../core/sync.js';
import { COLORS } from '../../config.js';

const C = new THREE.Vector3(0, 3, 0); // arena center
const H = 3.5; // half size of the cube
const PILLARS = [[-1.4, 0], [1.4, 0]];
const PILLAR_R = 0.15;
const BALL_R = 0.13;
const WIN = 7;
const THROW_BOOST = 1.5;
const DRILL_TIME = 60;
const BEST_KEY = 'qcg-dodgeball-best';
const _v = new THREE.Vector3();
const _h = new THREE.Vector3();

// Ball physics belongs to whoever last grabbed/threw the ball; they stream it at 20 Hz and judge
// whether it hit the other player. The host keeps the score.
export class Dodgeball extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.otherSide = app.otherSide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.score = { host: 0, guest: 0 };
    this.phase = this.solo ? 'drill' : 'play';
    this.move = new GrabMove(app);
    this.drift = new THREE.Vector3();
    this.handGrip = [false, false];
    this.sendAcc = 0;
    this.drillT = DRILL_TIME;
    this.drillScore = 0;
    this.best = Number(localStorage.getItem(BEST_KEY) || 0);
    this.flash = 0;

    this.buildArena();
    this.balls = [
      [-0.4, 3, 1.6], [0.4, 3, 1.6], [-0.4, 3, -1.6], [0.4, 3, -1.6],
    ].map((p, id) => this.makeBall(id, p));
    this.targets = [];
    if (this.solo) for (let i = 0; i < 3; i++) this.spawnTarget();

    const host = this.mySide === 'host';
    app.setRig(0, 1.4, host ? 2.6 : -2.6, host ? 0 : Math.PI);
    this.move.prev.copy(app.rig.position);
    app.toast(this.solo ? `Zero-G drill: hit the drones!\nSqueeze near a wall to pull yourself, throw balls` : `ZERO-G DODGEBALL: first to ${WIN} hits!\nGrab walls to move, grab balls to throw`, 5);
    if (!this.isHost) app.sendGame('join');
    this.refresh();
  }

  buildArena() {
    const root = this.root;
    this.app.scene.background = new THREE.Color(0x02030a);
    root.add(starfield(1200));
    root.add(new THREE.HemisphereLight(0xb8c4ff, 0x302040, 1.0));
    const box = new THREE.BoxGeometry(H * 2, H * 2, H * 2);
    const walls = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0x1a2a5a, transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false }));
    walls.position.copy(C);
    root.add(walls);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), lineMat(0x4f7bff, 0.9));
    edges.position.copy(C);
    root.add(edges);
    // Grid lines on each wall (where you can grab).
    const pts = [];
    for (let a = -H; a <= H + 1e-6; a += 1) {
      for (const s of [-H, H]) {
        pts.push(new THREE.Vector3(a, -H, s), new THREE.Vector3(a, H, s));
        pts.push(new THREE.Vector3(-H, a, s), new THREE.Vector3(H, a, s));
        pts.push(new THREE.Vector3(s, -H, a), new THREE.Vector3(s, H, a));
        pts.push(new THREE.Vector3(s, a, -H), new THREE.Vector3(s, a, H));
        pts.push(new THREE.Vector3(a, s, -H), new THREE.Vector3(a, s, H));
        pts.push(new THREE.Vector3(-H, s, a), new THREE.Vector3(H, s, a));
      }
    }
    const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat(0x2a3f8a, 0.35));
    grid.position.copy(C);
    root.add(grid);
    for (const [x, z] of PILLARS) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(PILLAR_R, PILLAR_R, H * 2, 16), new THREE.MeshLambertMaterial({ color: 0x3a4a7a }));
      p.position.set(x, C.y, z);
      root.add(p);
      for (let y = C.y - H + 0.5; y < C.y + H; y += 0.7) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(PILLAR_R + 0.02, 0.012, 6, 20), glowMat(0x7a9cff));
        ring.rotation.x = Math.PI / 2;
        ring.position.set(x, y, z);
        root.add(ring);
      }
    }
    // Home walls in each player's color.
    for (const side of ['host', 'guest']) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2), glowMat(COLORS[side], 0.06));
      plane.position.set(0, C.y, side === 'host' ? H - 0.01 : -H + 0.01);
      if (side === 'host') plane.rotation.y = Math.PI;
      root.add(plane);
    }
    this.boards = {};
    for (const side of ['host', 'guest']) {
      const l = new Label('', { w: 2.4, h: 0.45, res: 1024, size: 0.7 });
      l.mesh.position.set(0, C.y + 1.6, side === 'host' ? -H + 0.05 : H - 0.05);
      if (side === 'guest') l.mesh.rotation.y = Math.PI;
      this.root.add(l.mesh);
      this.boards[side] = l;
    }
  }

  makeBall(id, p) {
    const mat = glowMat(0xffffff);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 20, 14), mat);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 1.6, 14, 10), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    mesh.add(halo);
    this.root.add(mesh);
    return {
      id, mesh, mat, p: new THREE.Vector3(...p), v: new THREE.Vector3(), owner: 'host', hand: -1, remoteHeld: false, live: false,
      target: null, targetV: null,
    };
  }

  spawnTarget() {
    const t = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), glowMat(0xffb347));
    t.position.set((Math.random() - 0.5) * 4, C.y + (Math.random() - 0.5) * 4, -1 - Math.random() * 2.2);
    t.userData.v = new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.4);
    this.root.add(t);
    this.targets.push(t);
  }

  // ---------- movement ----------

  nearSurface(p) {
    const l = _v.copy(p).sub(C);
    if (H - Math.abs(l.x) < 0.14 || H - Math.abs(l.y) < 0.14 || H - Math.abs(l.z) < 0.14) return true;
    return PILLARS.some(([x, z]) => Math.hypot(p.x - x, p.z - z) < PILLAR_R + 0.12);
  }

  updateMovement(dt) {
    const app = this.app;
    app.hands.forEach((hand, i) => {
      if (!hand.connected) return;
      if (hand.state.squeeze.down) {
        const ball = this.balls.find((b) => b.hand < 0 && !b.remoteHeld && b.p.distanceTo(hand.pos) < 0.22);
        if (ball) this.grabBall(ball, i);
        else if (this.nearSurface(hand.pos)) {
          this.move.grab(i, hand.pos);
          this.handGrip[i] = true;
          hand.pulse(0.3, 20);
        }
      }
      if (hand.state.squeeze.up) {
        const ball = this.balls.find((b) => b.hand === i);
        if (ball) this.throwBall(ball, hand);
        if (this.handGrip[i]) {
          this.handGrip[i] = false;
          this.move.release(i);
          const other = 1 - i;
          if (this.handGrip[other]) this.move.grab(other, app.hands[other].pos); // still holding on
          else this.drift.copy(this.move.vel).clampLength(0, 6); // push off
        }
      }
    });
    const rig = app.rig;
    if (!this.move.holding) {
      // Gentle thrusters on the left stick (toward where you look).
      const left = app.hand('left');
      if (left && left.axes.length() > 0.15) {
        app.camera.getWorldDirection(_v);
        const right = _h.crossVectors(_v, new THREE.Vector3(0, 1, 0)).normalize();
        this.drift.addScaledVector(_v, -left.axes.y * 2.5 * dt).addScaledVector(right, left.axes.x * 2.5 * dt);
      }
      this.drift.multiplyScalar(Math.max(0, 1 - 0.35 * dt)).clampLength(0, 6);
      rig.position.addScaledVector(this.drift, dt);
    }
    this.move.update(dt);
    // Keep the head inside the cube.
    app.camera.getWorldPosition(_h);
    const lim = H - 0.3;
    for (const k of ['x', 'y', 'z']) {
      const off = _h[k] - C[k];
      if (Math.abs(off) > lim) {
        rig.position[k] -= off - Math.sign(off) * lim;
        if (Math.sign(this.drift[k]) === Math.sign(off)) this.drift[k] *= -0.3;
      }
    }
  }

  // ---------- balls ----------

  grabBall(ball, i) {
    ball.owner = this.mySide;
    ball.hand = i;
    ball.live = false;
    this.app.hands[i].pulse(0.5, 30);
    this.app.sfx.click();
    if (!this.solo) this.app.sendGame('grab', { id: ball.id });
  }

  throwBall(ball, hand) {
    ball.hand = -1;
    ball.v.copy(hand.vel).multiplyScalar(THROW_BOOST);
    ball.live = ball.v.length() > 2;
    this.app.sfx.whoosh(ball.p);
    this.sendBalls(true);
  }

  simulateOwned(dt) {
    const head = this.app.avatar.head.getWorldPosition(new THREE.Vector3()).toArray();
    for (const b of this.balls) {
      if (b.owner !== this.mySide) continue;
      if (b.hand >= 0) {
        const hand = this.app.hands[b.hand];
        b.p.copy(hand.pos).addScaledVector(hand.dir, 0.08);
        b.v.copy(hand.vel);
        continue;
      }
      this.integrate(b, dt);
      if (b.live && !this.solo && this.phase === 'play' && sphereHitsBody(b.p.toArray(), BALL_R, head)) {
        b.live = false;
        b.v.multiplyScalar(-0.3);
        this.registerHit(this.mySide);
      }
      if (b.live && this.solo) this.checkTargets(b);
    }
  }

  integrate(b, dt) {
    b.p.addScaledVector(b.v, dt);
    b.v.multiplyScalar(Math.max(0, 1 - 0.05 * dt));
    for (const k of ['x', 'y', 'z']) {
      const off = b.p[k] - C[k];
      const lim = H - BALL_R;
      if (Math.abs(off) > lim) {
        b.p[k] = C[k] + Math.sign(off) * (2 * lim - Math.abs(off));
        b.v[k] *= -0.85;
        if (b.live) this.app.sfx.bounce(b.p);
        b.live = false;
      }
    }
    for (const [x, z] of PILLARS) {
      const dx = b.p.x - x, dz = b.p.z - z;
      const d = Math.hypot(dx, dz);
      if (d < PILLAR_R + BALL_R && d > 1e-6) {
        const nx = dx / d, nz = dz / d;
        const vn = b.v.x * nx + b.v.z * nz;
        if (vn < 0) { b.v.x -= 1.85 * vn * nx; b.v.z -= 1.85 * vn * nz; }
        b.p.x = x + nx * (PILLAR_R + BALL_R);
        b.p.z = z + nz * (PILLAR_R + BALL_R);
        b.live = false;
      }
    }
  }

  checkTargets(b) {
    for (const t of [...this.targets]) {
      if (t.position.distanceTo(b.p) < 0.22 + BALL_R) {
        this.app.particles.burst(t.position, 0xffb347, 40, 3, 0.6);
        this.app.sfx.boom(t.position, false);
        this.root.remove(t);
        this.targets.splice(this.targets.indexOf(t), 1);
        this.drillScore++;
        b.live = false;
        this.spawnTarget();
      }
    }
  }

  // Remote-owned balls: smooth toward the owner's stream and coast in between.
  simulateRemote(dt) {
    for (const b of this.balls) {
      if (b.owner === this.mySide) continue;
      if (b.target) {
        b.p.lerp(b.target, 0.35);
        b.v.copy(b.targetV);
        b.target = null;
      } else if (!b.remoteHeld) this.integrate(b, dt);
    }
  }

  sendBalls(force = false) {
    if (this.solo) return;
    const mine = this.balls.filter((b) => b.owner === this.mySide);
    if (!mine.length && !force) return;
    this.app.sendGame('balls', {
      b: mine.map((b) => [b.id, r2(b.p.x), r2(b.p.y), r2(b.p.z), r2(b.v.x), r2(b.v.y), r2(b.v.z), b.live ? 1 : 0, b.hand >= 0 ? 1 : 0]),
    }, false);
  }

  registerHit(thrower) {
    if (this.isHost) {
      this.score[thrower]++;
      if (this.score[thrower] >= WIN) this.phase = 'over';
      this.app.sendGame('score', { score: this.score, scorer: thrower, phase: this.phase });
      this.onScore(thrower);
    } else this.app.sendGame('hit');
  }

  onScore(scorer) {
    const mine = scorer === this.mySide;
    this.app.sfx.goal(mine);
    this.app.toast(mine ? 'HIT! +1' : 'You got hit!', 1.5);
    if (!mine) {
      this.flash = 0.5;
      for (const h of this.app.hands) h.pulse(1, 150);
    }
    if (this.phase === 'over') this.showOver();
  }

  onNet(k, d) {
    if (k === 'join' && this.isHost) this.app.sendGame('score', { score: this.score, scorer: null, phase: this.phase });
    else if (k === 'grab') {
      const b = this.balls[d.id];
      if (b.hand >= 0) {
        // Both grabbed at once: the host keeps it.
        if (this.isHost) { this.app.sendGame('deny', { id: d.id }); return; }
        b.hand = -1;
      }
      b.owner = this.otherSide;
      b.remoteHeld = true;
      b.live = false;
    } else if (k === 'deny') {
      const b = this.balls[d.id];
      b.hand = -1;
      b.owner = this.otherSide;
    } else if (k === 'balls') {
      const lag = Math.min(this.app.net.rtt / 2, 200) / 1000;
      for (const [id, px, py, pz, vx, vy, vz, live, held] of d.b) {
        const b = this.balls[id];
        if (b.owner === this.mySide) continue;
        b.targetV = new THREE.Vector3(vx, vy, vz);
        b.target = new THREE.Vector3(px, py, pz).addScaledVector(b.targetV, held ? 0 : lag);
        b.live = !!live;
        b.remoteHeld = !!held;
      }
    } else if (k === 'hit' && this.isHost) {
      if (this.phase === 'play') this.registerHit(this.otherSide);
    } else if (k === 'score' && !this.isHost) {
      this.score = d.score;
      this.phase = d.phase;
      if (d.scorer) this.onScore(d.scorer);
    } else if (k === 'rematch' && this.isHost) this.app.requestGame('dodgeball');
  }

  // ---------- frame ----------

  update(dt, t) {
    this.updateMovement(dt);
    this.simulateOwned(dt);
    this.simulateRemote(dt);
    this.sendAcc += dt;
    if (this.sendAcc >= 0.05) { this.sendAcc = 0; this.sendBalls(); }
    for (const b of this.balls) {
      b.mesh.position.copy(b.p);
      b.mat.color.set(b.hand >= 0 ? this.app.myColor : b.remoteHeld ? this.app.partnerColor : b.live ? 0xffee88 : 0xffffff);
    }
    if (this.solo) {
      for (const tg of this.targets) {
        tg.position.addScaledVector(tg.userData.v, dt);
        tg.rotation.y = t;
        for (const k of ['x', 'y', 'z']) if (Math.abs(tg.position[k] - C[k]) > H - 0.6) tg.userData.v[k] *= -1;
      }
      if (this.phase === 'drill') {
        this.drillT -= dt;
        if (this.drillT <= 0) {
          this.phase = 'drillover';
          if (this.drillScore > this.best) { this.best = this.drillScore; localStorage.setItem(BEST_KEY, String(this.best)); }
          this.showOver();
        }
      }
    }
    this.flash = Math.max(0, this.flash - dt);
    this.refresh();
  }

  refresh() {
    if (this.solo) {
      this.boards.host.set(`TIME ${Math.max(0, Math.ceil(this.drillT))}   ·   DRONES ${this.drillScore}   ·   BEST ${this.best}`);
      this.boards.guest.set('');
      return;
    }
    for (const side of ['host', 'guest']) {
      const other = side === 'host' ? 'guest' : 'host';
      this.boards[side].set(`YOU ${this.score[side]}  :  ${this.score[other]} THEM`, this.flash > 0 && side === this.mySide ? '#ff6b6b' : '#ffffff');
    }
  }

  showOver() {
    if (!this.overPanel) {
      this.overPanel = this.app.ui.add(new Panel({ w: 1.1, h: 0.7, cols: 2 }));
      this.attach(this.app.rig, this.overPanel.mesh);
    }
    const won = this.solo || this.score[this.mySide] >= WIN;
    this.overPanel.set({
      title: this.solo ? `${this.drillScore} DRONES` : won ? 'VICTORY!' : 'DEFEATED',
      accent: won ? '#7dff8a' : '#ff6b6b',
      lines: [this.solo ? `Best: ${this.best}` : `Final: ${this.score[this.mySide]} : ${this.score[this.otherSide]}`],
      buttons: [
        { label: this.solo ? 'Again' : 'Rematch', onClick: () => (this.isHost ? this.app.requestGame('dodgeball') : this.app.sendGame('rematch')) },
        { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
      ],
    });
    // Floats in front of you wherever you drifted to.
    this.overPanel.mesh.position.set(0, 1.5, -1.2);
    this.overPanel.mesh.visible = true;
  }
}
