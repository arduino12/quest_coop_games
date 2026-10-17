import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { smoothMove } from '../../core/locomotion.js';
import { glowMat, lineMat, rectLoop, starfield } from '../../core/env.js';
import { COLORS, CSS_COLORS } from '../../config.js';
import {
  T, WIN_SCORE, MAX_SPEED, stepBall, paddleHit, sideOf, otherSide, newBall, cloneBall,
} from './logic.js';

const PLAYER_Z = 6.0;
const SUBSTEPS = 4;
const HIT_COOLDOWN = 0.15;
const TRAIL = 24;
const BEST_KEY = 'qcg-handball-best';

const _hp = new THREE.Vector3();

// Netcode: whoever's half the ball is in owns it. Hits happen on your own half, so they are
// computed locally (no lag) and sent with the new ball state; the other side fast-forwards
// it by half the round-trip time. The host keeps the score.
export class Handball extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.solo = !app.net.connected;
    this.isHost = app.role !== 'guest';
    this.score = { host: 0, guest: 0 };
    this.phase = 'play';
    this.winner = null;
    this.ball = newBall('host');
    this.frozen = false; // waiting for the owner to report a goal
    this.rally = 0;
    this.best = Number(localStorage.getItem(BEST_KEY) || 0);
    this.flash = { host: 0, guest: 0 };
    this.handPrev = app.hands.map((h) => h.pos.clone());
    this.lastHit = -1;
    this.trail = [];

    this.buildScene();
    this.buildHands();
    app.setRig(0, 0, this.mySide === 'host' ? PLAYER_Z : -PLAYER_Z, this.mySide === 'host' ? 0 : Math.PI);
    app.toast(this.solo ? 'Practice: smack the ball at the far wall!' : `First to ${WIN_SCORE} wins!\nHit the ball with your hands`, 4);
    if (!this.isHost) app.sendGame('join');
    this.refreshScore();
  }

  buildScene() {
    const { halfL: L, halfW: W, H } = T;
    const root = this.root;
    this.app.scene.background = new THREE.Color(0x04020f);
    this.app.scene.fog = new THREE.Fog(0x04020f, 14, 34);
    root.add(starfield(800));

    const frameMat = lineMat(0x3355ff, 0.35);
    for (let z = -L; z <= L + 1e-6; z += 1) {
      const r = rectLoop(W * 2, H, z === 0 ? 0xffffff : 0x3355ff, z === 0 ? 0.6 : 0.35);
      r.position.z = z;
      root.add(r);
    }
    const pts = [];
    const seg = (a, b) => pts.push(new THREE.Vector3(...a), new THREE.Vector3(...b));
    for (const x of [-W, -W / 2, 0, W / 2, W]) { seg([x, 0, -L], [x, 0, L]); seg([x, H, -L], [x, H, L]); }
    for (const y of [H / 3, (2 * H) / 3]) { seg([-W, y, -L], [-W, y, L]); seg([W, y, -L], [W, y, L]); }
    root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), frameMat));

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, L * 2), new THREE.MeshBasicMaterial({ color: 0x0a0720 }));
    floor.rotation.x = -Math.PI / 2;
    root.add(floor);
    // Standing pads at each end so players know where to be.
    for (const side of ['host', 'guest']) {
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.5, 40), glowMat(COLORS[side], 0.7));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(0, 0.01, side === 'host' ? PLAYER_Z : -PLAYER_Z);
      root.add(pad);
    }

    this.goalWalls = {};
    for (const side of ['host', 'guest']) {
      const z = side === 'host' ? L : -L;
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, H), new THREE.MeshBasicMaterial({
        color: COLORS[side], transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
      }));
      wall.position.set(0, H / 2, z);
      root.add(wall);
      const border = rectLoop(W * 2, H, COLORS[side], 1);
      border.position.z = z;
      root.add(border);
      this.goalWalls[side] = wall;
    }
    if (this.solo) this.goalWalls.guest.material.color.set(0x888899);

    this.ballMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.ballMesh = new THREE.Mesh(new THREE.SphereGeometry(T.ballR, 24, 16), this.ballMat);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(T.ballR * 1.9, 16, 12), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.halo = halo;
    this.ballMesh.add(halo);
    root.add(this.ballMesh);

    // Depth cues: a frame that slides along the tunnel with the ball, plus a floor shadow.
    this.depthRing = rectLoop(W * 2, H, 0xffffff, 0.9);
    root.add(this.depthRing);
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(T.ballR * 1.2, 20), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false,
    }));
    this.shadow.rotation.x = -Math.PI / 2;
    root.add(this.shadow);

    this.trailPos = new Float32Array(TRAIL * 3);
    const tg = new THREE.BufferGeometry();
    this.trailAttr = new THREE.BufferAttribute(this.trailPos, 3);
    tg.setAttribute('position', this.trailAttr);
    this.trailLine = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    this.trailLine.frustumCulled = false;
    root.add(this.trailLine);

    // Scoreboards above the middle, one facing each player.
    this.boards = {};
    for (const side of ['host', 'guest']) {
      const label = new Label('', { w: 2.4, h: 0.5, res: 1024, size: 0.7 });
      label.mesh.position.set(0, H + 0.45, 0);
      if (side === 'guest') label.mesh.rotation.y = Math.PI;
      root.add(label.mesh);
      this.boards[side] = label;
    }
  }

  buildHands() {
    const app = this.app;
    const orb = (color) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), glowMat(color)));
      const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(T.handR, 1), new THREE.MeshBasicMaterial({
        color, wireframe: true, transparent: true, opacity: 0.55,
      }));
      g.add(shell);
      return g;
    };
    this.myOrbs = app.hands.map((h) => {
      h.visual.visible = false;
      return this.attach(h.grip, orb(app.myColor));
    });
    app.avatar.setHandDotsVisible(false);
    this.attach(app.avatar.hands.left, orb(app.partnerColor));
    this.attach(app.avatar.hands.right, orb(app.partnerColor));
  }

  // ---------- simulation ----------

  update(dt, t) {
    this.locomote(dt);
    if (this.phase === 'play' && !this.frozen) this.simulate(dt);
    this.app.hands.forEach((h, i) => this.handPrev[i].copy(h.pos));
    this.render(dt, t);
  }

  locomote(dt) {
    const host = this.mySide === 'host';
    smoothMove(this.app, dt, {
      speed: 1.8,
      clamp: (p) => {
        p.x = THREE.MathUtils.clamp(p.x, -1.1, 1.1);
        p.z = host ? THREE.MathUtils.clamp(p.z, 4.2, 6.6) : THREE.MathUtils.clamp(p.z, -6.6, -4.2);
      },
    });
  }

  simulate(dt) {
    const app = this.app;
    const h = dt / SUBSTEPS;
    for (let s = 1; s <= SUBSTEPS; s++) {
      const b = this.ball;
      if (b.live) {
        const z0 = b.p[2];
        const ev = stepBall(b, h, this.solo);
        if (ev.bounce) app.sfx.bounce(b.p);
        if (ev.goal) { this.onGoalLine(ev.goal); return; }
        // Ball just left my half: hand the exact state to the other side to avoid drift.
        if (!this.solo && sideOf(z0) === this.mySide && sideOf(b.p[2]) !== this.mySide) this.sendBall(false);
      }
      if (sideOf(b.p[2]) !== this.mySide) continue;
      if (app.time - this.lastHit < HIT_COOLDOWN) continue;
      for (let i = 0; i < app.hands.length; i++) {
        const hand = app.hands[i];
        if (!hand.connected) continue;
        _hp.lerpVectors(this.handPrev[i], hand.pos, s / SUBSTEPS);
        if (paddleHit(b, _hp.toArray(), hand.vel.toArray(), this.mySide)) {
          b.hits++;
          this.lastHit = app.time;
          this.onMyHit(hand, i);
          break;
        }
      }
    }
  }

  onMyHit(hand, i) {
    const app = this.app;
    const speed = Math.hypot(...this.ball.v);
    app.sfx.hit(this.ball.p, speed);
    hand.pulse(Math.min(1, 0.4 + speed / MAX_SPEED), 60);
    app.particles.burst(this.ball.p, app.myColor, 24, 2.5, 0.4);
    this.myOrbs[i].scale.setScalar(1.5);
    if (this.solo) this.rally++;
    else this.sendBall(true);
  }

  sendBall(hit) {
    this.app.sendGame('ball', { b: cloneBall(this.ball), hit });
  }

  // The ball passed `wall`'s back wall.
  onGoalLine(wall) {
    const b = this.ball;
    if (this.solo) {
      this.flash.host = 1;
      this.app.sfx.goal(false);
      if (this.rally > this.best) {
        this.best = this.rally;
        localStorage.setItem(BEST_KEY, String(this.best));
        this.app.toast(`New best rally: ${this.best}!`);
      }
      this.rally = 0;
      this.ball = newBall('host');
      this.refreshScore();
      return;
    }
    if (wall !== this.mySide) {
      // Not my half: the other player is the referee for this one.
      this.frozen = true;
      b.live = false;
      return;
    }
    const scorer = otherSide(wall);
    if (this.isHost) this.registerGoal(scorer);
    else {
      this.app.sendGame('goal', { scorer });
      this.frozen = true;
      b.live = false;
    }
  }

  // Host only.
  registerGoal(scorer) {
    this.score[scorer]++;
    if (this.score[scorer] >= WIN_SCORE) {
      this.phase = 'over';
      this.winner = scorer;
    }
    this.ball = newBall(otherSide(scorer));
    this.frozen = false;
    this.broadcastState(scorer);
    this.applyGoalFx(scorer);
    this.refreshScore();
    if (this.phase === 'over') this.showOver();
  }

  broadcastState(goal = null) {
    this.app.sendGame('state', {
      score: this.score, ball: cloneBall(this.ball), phase: this.phase, winner: this.winner, goal,
    });
  }

  applyGoalFx(scorer) {
    const conceder = otherSide(scorer);
    this.flash[conceder] = 1;
    this.app.sfx.goal(scorer === this.mySide);
    const z = conceder === 'host' ? T.halfL : -T.halfL;
    this.app.particles.burst([0, T.H / 2, z], COLORS[scorer], 60, 4, 0.8);
  }

  restart() {
    this.score = { host: 0, guest: 0 };
    this.phase = 'play';
    this.winner = null;
    this.ball = newBall('host');
    this.frozen = false;
    this.hideOver();
    this.refreshScore();
    this.broadcastState();
  }

  onNet(k, d) {
    if (k === 'join' && this.isHost) this.broadcastState();
    else if (k === 'ball') {
      if (this.phase !== 'play') return;
      this.ball = d.b;
      this.frozen = false;
      // Catch up for the time the message spent in flight.
      let lag = Math.min(this.app.net.rtt / 2, 250) / 1000;
      while (lag > 1e-4) {
        const step = Math.min(0.01, lag);
        lag -= step;
        const ev = stepBall(this.ball, step, this.solo);
        if (ev.goal) { this.onGoalLine(ev.goal); break; }
      }
      if (d.hit) {
        this.app.sfx.hit(this.ball.p, Math.hypot(...this.ball.v));
        this.app.particles.burst(this.ball.p, this.app.partnerColor, 24, 2.5, 0.4);
      }
    } else if (k === 'goal' && this.isHost) {
      if (this.phase === 'play') this.registerGoal(d.scorer);
    } else if (k === 'state' && !this.isHost) {
      this.score = d.score;
      this.ball = d.ball;
      this.phase = d.phase;
      this.winner = d.winner;
      this.frozen = false;
      if (d.goal) this.applyGoalFx(d.goal);
      this.refreshScore();
      if (this.phase === 'over') this.showOver();
      else this.hideOver();
    } else if (k === 'rematch' && this.isHost) this.restart();
  }

  // ---------- presentation ----------

  refreshScore() {
    if (this.solo) {
      this.boards.host.set(`RALLY ${this.rally}   ·   BEST ${this.best}`);
      this.boards.guest.set('');
      return;
    }
    for (const side of ['host', 'guest']) {
      const other = otherSide(side);
      this.boards[side].set(`YOU ${this.score[side]}  :  ${this.score[other]} THEM`);
    }
  }

  showOver() {
    const won = this.winner === this.mySide;
    const z = this.mySide === 'host' ? PLAYER_Z - 1.6 : -PLAYER_Z + 1.6;
    if (!this.overPanel) {
      this.overPanel = this.app.ui.add(new Panel({ w: 1.2, h: 0.75 }));
      this.root.add(this.overPanel.mesh);
    }
    this.overPanel.set({
      title: won ? 'YOU WIN!' : 'You lose…',
      accent: won ? '#7dff8a' : CSS_COLORS[this.app.otherSide],
      lines: [`Final score ${this.score[this.mySide]} : ${this.score[otherSide(this.mySide)]}`],
      cols: 2,
      buttons: [
        { label: 'Rematch', onClick: () => (this.isHost ? this.restart() : this.app.sendGame('rematch')) },
        { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
      ],
    });
    this.overPanel.mesh.position.set(0, 1.45, z);
    this.overPanel.mesh.rotation.y = this.mySide === 'host' ? 0 : Math.PI;
    this.overPanel.mesh.visible = true;
  }

  hideOver() {
    if (this.overPanel) this.overPanel.mesh.visible = false;
  }

  render(dt, t) {
    const b = this.ball;
    const visible = this.phase === 'play' && !this.frozen;
    this.ballMesh.visible = this.depthRing.visible = this.shadow.visible = visible;
    const bob = b.live ? 0 : Math.sin(t * 3) * 0.04;
    this.ballMesh.position.set(b.p[0], b.p[1] + bob, b.p[2]);
    const speed = Math.hypot(b.v[0], b.v[1], b.v[2]);
    const heat = Math.min(1, speed / MAX_SPEED);
    this.ballMat.color.setRGB(1, 1 - heat * 0.6, 1 - heat * 0.9);
    this.halo.scale.setScalar(1 + heat * 0.8 + (b.live ? 0 : Math.sin(t * 6) * 0.15));
    this.depthRing.position.z = b.p[2];
    this.depthRing.material.opacity = 0.35 + 0.5 * Math.abs(b.p[2]) / T.halfL;
    this.shadow.position.set(b.p[0], 0.005, b.p[2]);
    this.shadow.scale.setScalar(1 + b.p[1] * 0.3);

    if (b.live && visible) this.trail.unshift(b.p[0], b.p[1], b.p[2]);
    else this.trail.length = 0;
    if (this.trail.length > TRAIL * 3) this.trail.length = TRAIL * 3;
    for (let i = 0; i < TRAIL * 3; i++) this.trailPos[i] = this.trail[i] ?? this.trail[i % 3] ?? 0;
    this.trailAttr.needsUpdate = true;
    this.trailLine.visible = this.trail.length > 3;

    for (const side of ['host', 'guest']) {
      this.flash[side] = Math.max(0, this.flash[side] - dt * 1.5);
      this.goalWalls[side].material.opacity = 0.1 + this.flash[side] * 0.6;
    }
    for (const o of this.myOrbs) o.scale.lerp(new THREE.Vector3(1, 1, 1), Math.min(1, dt * 10));
    if (this.solo) this.refreshScore();
  }
}
