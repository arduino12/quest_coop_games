import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { glowMat, starfield } from '../../core/env.js';
import { distSegSeg, distPointSeg, segHitsBody } from '../../core/geom.js';
import { CSS_COLORS } from '../../config.js';

const BLADE_START = 0.06;
const BLADE_END = 1.0;
const WIN = 5;
const HIT_SPEED = 1.3; // blade tip m/s needed for a touch to count
const PARRY_T = 0.35; // after a block, the attacker's blade is harmless this long
const PAUSE = 2.2;
const START_Z = 0.85;
const DRILL_TIME = 60;
const BEST_KEY = 'qcg-fencing-best';
const _f = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

function bladeOf(obj) {
  obj.getWorldPosition(_p);
  obj.getWorldQuaternion(_q);
  _f.set(0, 0, -1).applyQuaternion(_q);
  return [_p.clone().addScaledVector(_f, BLADE_START).toArray(), _p.clone().addScaledVector(_f, BLADE_END).toArray()];
}

// Defender-side judging: each player's own headset decides whether the opponent's blade
// (as they see it) touched them, and whether their own blade or shield blocked it first.
export class Fencing extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.score = { host: 0, guest: 0 };
    this.phase = this.solo ? 'drill' : 'fight'; // fight | point | over | drill | drillover
    this.pauseT = 0;
    this.parryT = 0;
    this.clashCool = 0;
    this.prevTip = null;
    this.prevMyTip = null;
    this.drillT = DRILL_TIME;
    this.drillScore = 0;
    this.best = Number(localStorage.getItem(BEST_KEY) || 0);
    this.orbs = [];

    this.buildArena();
    this.buildSwords();
    app.setRig(0, 0, this.mySide === 'host' ? START_Z : -START_Z, this.mySide === 'host' ? 0 : Math.PI);
    if (this.solo) {
      for (let i = 0; i < 3; i++) this.spawnOrb();
      app.toast(`Sword drill: slash the orbs!\n${DRILL_TIME} seconds`, 4);
    } else app.toast(`EN GARDE! First to ${WIN} touches.\nRight hand: sword, left hand: shield`, 4);
    if (!this.isHost) app.sendGame('join');
    this.refresh();
  }

  buildArena() {
    const root = this.root;
    this.app.scene.background = new THREE.Color(0x05040c);
    this.app.scene.fog = new THREE.Fog(0x05040c, 8, 30);
    root.add(starfield(900));
    root.add(new THREE.HemisphereLight(0xb0b8ff, 0x201830, 0.8));
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.05, 48), new THREE.MeshLambertMaterial({ color: 0x141428 }));
    disc.position.y = -0.025;
    root.add(disc);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.02, 6, 64), glowMat(0x7a5cff));
    edge.rotation.x = Math.PI / 2;
    root.add(edge);
    const mid = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.01, 0.03), glowMat(0xffffff, 0.6));
    root.add(mid);
    for (const side of ['host', 'guest']) {
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.4, 40), glowMat(new THREE.Color(CSS_COLORS[side]), 0.8));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(0, 0.01, side === 'host' ? START_Z : -START_Z);
      root.add(pad);
    }
    this.boards = {};
    for (const side of ['host', 'guest']) {
      const l = new Label('', { w: 2.2, h: 0.4, res: 1024, size: 0.7 });
      l.mesh.position.set(0, 2.6, side === 'host' ? -2.6 : 2.6);
      if (side === 'guest') l.mesh.rotation.y = Math.PI;
      root.add(l.mesh);
      this.boards[side] = l;
    }
  }

  makeSword(color) {
    const g = new THREE.Group();
    const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.14, 12), new THREE.MeshLambertMaterial({ color: 0x9aa0b0 }));
    hilt.rotation.x = -Math.PI / 2;
    hilt.position.z = 0.03;
    const len = BLADE_END - BLADE_START;
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, len, 10), glowMat(0xffffff));
    blade.rotation.x = -Math.PI / 2;
    blade.position.z = -(BLADE_START + len / 2);
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 10), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.z = blade.position.z;
    g.add(hilt, blade, glow);
    return g;
  }

  makeShield(color) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.01, 32), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    s.rotation.x = Math.PI / 2;
    s.position.z = -0.05;
    return s;
  }

  buildSwords() {
    const app = this.app;
    for (const h of app.hands) h.visual.visible = false;
    // Hands are found by handedness each frame; attach to both grips and show the right one.
    this.mySwords = app.hands.map((h) => this.attach(h.grip, this.makeSword(app.myColor)));
    this.myShields = app.hands.map((h) => this.attach(h.grip, this.makeShield(app.myColor)));
    app.avatar.setHandDotsVisible(false);
    this.theirSword = this.attach(app.avatar.hands.right, this.makeSword(app.partnerColor));
    this.attach(app.avatar.hands.left, this.makeShield(app.partnerColor));
  }

  // ---------- drill (solo) ----------

  spawnOrb() {
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), glowMat(0xffb347));
    const rig = this.app.rig;
    orb.position.set(rig.position.x + (Math.random() - 0.5) * 1.1, 0.95 + Math.random() * 0.85, rig.position.z - 0.55 - Math.random() * 0.45);
    this.root.add(orb);
    this.orbs.push(orb);
  }

  updateDrill(dt, my, mySpeed) {
    this.drillT -= dt;
    if (this.drillT <= 0) {
      this.phase = 'drillover';
      if (this.drillScore > this.best) {
        this.best = this.drillScore;
        localStorage.setItem(BEST_KEY, String(this.best));
      }
      this.showOver();
      return;
    }
    if (!my || mySpeed < 1.5) return;
    for (const orb of [...this.orbs]) {
      if (distPointSeg(orb.position.toArray(), my[0], my[1]) < 0.09) {
        this.app.particles.burst(orb.position, 0xffb347, 30, 2.5, 0.5);
        this.app.sfx.hit(orb.position, 8);
        this.app.hand('right')?.pulse(0.7, 40);
        this.root.remove(orb);
        this.orbs.splice(this.orbs.indexOf(orb), 1);
        this.drillScore++;
        this.spawnOrb();
      }
    }
  }

  // ---------- duel ----------

  update(dt) {
    const app = this.app;
    const right = app.hand('right');
    const left = app.hand('left');
    app.hands.forEach((h, i) => {
      this.mySwords[i].visible = h === right;
      this.myShields[i].visible = h === left;
    });
    const my = right ? bladeOf(this.mySwords[app.hands.indexOf(right)]) : null;
    const myTip = my ? my[1] : null;
    const mySpeed = myTip && this.prevMyTip ? Math.hypot(myTip[0] - this.prevMyTip[0], myTip[1] - this.prevMyTip[1], myTip[2] - this.prevMyTip[2]) / Math.max(dt, 1e-3) : 0;
    this.prevMyTip = myTip;

    if (this.phase === 'drill') this.updateDrill(dt, my, mySpeed);
    this.parryT -= dt;
    this.clashCool -= dt;
    if (this.phase === 'point') {
      this.pauseT -= dt;
      if (this.pauseT <= 0) {
        this.phase = 'fight';
        app.toast('EN GARDE!', 1.2);
        app.sfx.tone({ f: 660, dur: 0.15, type: 'triangle', vol: 0.2 });
      }
    }

    if (!this.solo && app.avatar.group.visible && app.avatar.hands.right.visible) {
      const theirs = bladeOf(this.theirSword);
      const tip = theirs[1];
      const speed = this.prevTip ? Math.hypot(tip[0] - this.prevTip[0], tip[1] - this.prevTip[1], tip[2] - this.prevTip[2]) / Math.max(dt, 1e-3) : 0;
      this.prevTip = tip;
      // Blade-on-blade clash or shield block cancels their attack for a moment.
      if (my && distSegSeg(my[0], my[1], theirs[0], theirs[1]) < 0.04) this.block('clash', my, right);
      else if (left && distPointSeg(left.pos.toArray(), theirs[0], theirs[1]) < 0.16) this.block('shield', theirs, left);
      if (this.phase === 'fight' && this.parryT <= 0 && speed > HIT_SPEED) {
        const head = app.camera.getWorldPosition(new THREE.Vector3()).toArray();
        const part = segHitsBody(theirs[0], theirs[1], head);
        if (part) this.touched(part);
      }
    }
    this.refresh();
  }

  block(kind, seg, hand) {
    this.parryT = PARRY_T;
    if (this.clashCool > 0) return;
    this.clashCool = 0.15;
    const p = kind === 'clash' ? seg[1] : hand.pos.toArray();
    this.app.particles.burst(p, kind === 'clash' ? 0xffffff : this.app.myColor, 25, 2.5, 0.35);
    this.app.sfx.tone({ f: kind === 'clash' ? 1400 : 500, f2: kind === 'clash' ? 700 : 250, dur: 0.12, type: 'sawtooth', vol: 0.18, pos: p });
    hand.pulse(0.9, 60);
    if (!this.solo) this.app.sendGame('clash', { p, kind });
  }

  // I was touched by the opponent.
  touched(part) {
    this.phase = 'point';
    this.pauseT = PAUSE;
    const scorer = this.mySide === 'host' ? 'guest' : 'host';
    if (this.isHost) this.registerPoint(scorer, part);
    else this.app.sendGame('touched', { part });
  }

  registerPoint(scorer, part) {
    this.score[scorer]++;
    this.phase = this.score[scorer] >= WIN ? 'over' : 'point';
    this.pauseT = PAUSE;
    this.app.sendGame('point', { score: this.score, scorer, part, phase: this.phase });
    this.onPoint(scorer, part);
  }

  onPoint(scorer, part) {
    const mine = scorer === this.mySide;
    this.app.toast(`${mine ? 'TOUCH! Point for you' : 'You were hit'} (${part})`, 1.8);
    this.app.sfx.goal(mine);
    if (!mine) for (const h of this.app.hands) h.pulse(1, 150);
    if (this.phase === 'over') this.showOver();
  }

  onNet(k, d) {
    if (k === 'join' && this.isHost) this.app.sendGame('point', { score: this.score, scorer: null, phase: this.phase === 'over' ? 'over' : 'fight' });
    else if (k === 'touched' && this.isHost) {
      if (this.phase === 'fight' || this.phase === 'point') {
        if (this.phase === 'point' && this.pauseT < PAUSE - 0.2) return; // already scoring another touch
        this.registerPoint(this.mySide, d.part);
      }
    } else if (k === 'point' && !this.isHost) {
      this.score = d.score;
      this.phase = d.phase;
      this.pauseT = PAUSE;
      if (d.scorer) this.onPoint(d.scorer, d.part);
      if (this.phase !== 'over') this.hideOver();
    } else if (k === 'clash') {
      this.app.particles.burst(d.p, 0xffffff, 15, 2, 0.3);
    } else if (k === 'rematch' && this.isHost) this.app.requestGame('fencing');
  }

  // ---------- panels ----------

  refresh() {
    if (this.solo) {
      this.boards.host.set(`TIME ${Math.max(0, Math.ceil(this.drillT))}   ·   ORBS ${this.drillScore}   ·   BEST ${this.best}`);
      this.boards.guest.set('');
      return;
    }
    for (const side of ['host', 'guest']) {
      const other = side === 'host' ? 'guest' : 'host';
      this.boards[side].set(`YOU ${this.score[side]}  :  ${this.score[other]} THEM`);
    }
  }

  showOver() {
    if (!this.overPanel) {
      this.overPanel = this.app.ui.add(new Panel({ w: 1.1, h: 0.7, cols: 2 }));
      this.root.add(this.overPanel.mesh);
    }
    const won = this.solo ? true : this.score[this.mySide] >= WIN;
    this.overPanel.set({
      title: this.solo ? `${this.drillScore} ORBS` : won ? 'VICTORY!' : 'DEFEATED',
      accent: won ? '#7dff8a' : '#ff6b6b',
      lines: [this.solo ? `Best: ${this.best}` : `Final: ${this.score[this.mySide]} : ${this.score[this.mySide === 'host' ? 'guest' : 'host']}`],
      buttons: [
        { label: this.solo ? 'Again' : 'Rematch', onClick: () => (this.isHost ? this.app.requestGame('fencing') : this.app.sendGame('rematch')) },
        { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
      ],
    });
    const z = this.app.rig.position.z;
    const host = this.mySide === 'host';
    this.overPanel.mesh.position.set(0.9 * (host ? 1 : -1), 1.4, z + (host ? -0.6 : 0.6));
    this.overPanel.mesh.rotation.y = host ? -0.6 : Math.PI - 0.6;
    this.overPanel.mesh.visible = true;
  }

  hideOver() {
    if (this.overPanel) this.overPanel.mesh.visible = false;
  }
}
