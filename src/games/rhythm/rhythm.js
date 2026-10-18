import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { glowMat, lineMat, starfield, gridFloor } from '../../core/env.js';
import {
  BEAT, SONG_BEATS, WINDOW, ATTACK_EVERY, LANE_HAND, judge, multiplier, generateChart, attackNotes, bassNote, midiHz,
} from './logic.js';

const SPEED = 7; // m/s toward the player
const AHEAD = 2.4; // seconds of notes visible
const START_DELAY = 3;
const SIDE_X = { host: -1.2, guest: 1.2 };
const HAND_HEX = { left: 0x33aaff, right: 0xff3d8a };
const BEST_KEY = 'qcg-rhythm-best';
const _v = new THREE.Vector3();

// Both players play the same generated song and chart at the same time; each is judged on their own
// headset against their own audio clock. Scores are exchanged, and combos send "attacks" (extra notes).
export class Rhythm extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.otherSide = app.otherSide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.phase = 'wait'; // wait -> play -> done
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.hits = 0;
    this.misses = 0;
    this.theirs = { score: 0, combo: 0, final: null };
    this.best = Number(localStorage.getItem(BEST_KEY) || 0);
    this.notes = [];
    this.scheduledBeat = 0;
    this.sendAcc = 0;
    this.pulse = 0;
    this.lanes = null;

    this.buildStage();
    app.setRig(this.solo ? 0 : SIDE_X[this.mySide], 0, 0, 0);
    if (this.isHost) {
      this.seed = Math.floor(Math.random() * 1e9);
      if (this.solo) this.start(this.seed, START_DELAY);
      else app.toast('Waiting for your rival…', 3);
    } else app.sendGame('join');
  }

  get ctx() { return this.app.sfx.ready ? this.app.sfx.ctx : null; }
  now() { return this.ctx ? this.ctx.currentTime : performance.now() / 1000; }
  songTime() { return this.now() - this.t0; }

  buildStage() {
    const root = this.root;
    this.app.scene.background = new THREE.Color(0x07020f);
    this.app.scene.fog = new THREE.Fog(0x07020f, 10, 30);
    root.add(starfield(1000));
    const grid = gridFloor(40, 40, 0x6a2aff, 0.4);
    root.add(grid);
    this.grid = grid;
    this.board = new Label('', { w: 1.6, h: 0.36, res: 1024, size: 0.5 });
    this.board.mesh.position.set(this.solo ? 0 : SIDE_X[this.mySide], 2.55, -3);
    root.add(this.board.mesh);
    this.feedback = new Label('', { w: 0.8, h: 0.16, res: 512, size: 0.75 });
    root.add(this.feedback.mesh);
    this.feedbackT = 0;
    this.noteGeo = new THREE.SphereGeometry(0.085, 18, 12);
    this.noteMats = { left: glowMat(HAND_HEX.left), right: glowMat(HAND_HEX.right), extra: glowMat(0xffee33) };
  }

  // Lanes are fitted to the player's height when the song starts.
  calibrate() {
    const head = this.app.camera.getWorldPosition(new THREE.Vector3());
    const hi = head.y - 0.12, lo = head.y - 0.5, z = head.z - 0.55;
    this.lanes = [
      new THREE.Vector3(head.x - 0.3, hi, z), new THREE.Vector3(head.x - 0.35, lo, z),
      new THREE.Vector3(head.x + 0.3, hi, z), new THREE.Vector3(head.x + 0.35, lo, z),
    ];
    this.lanes.forEach((p, i) => {
      const color = HAND_HEX[LANE_HAND[i]];
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.12, 32), glowMat(color, 0.8));
      ring.position.copy(p);
      this.root.add(ring);
      const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, p.clone().add(new THREE.Vector3(0, 0, -SPEED * AHEAD))]), lineMat(color, 0.25));
      this.root.add(guide);
    });
    this.feedback.mesh.position.set(head.x, hi + 0.3, z - 0.2);
  }

  start(seed, delay) {
    this.seed = seed;
    this.chart = generateChart(seed);
    this.notes = this.chart.map((n) => ({ ...n, state: 'pending', mesh: null }));
    this.t0 = this.now() + delay;
    this.scheduledBeat = -4; // four count-in clicks
    this.phase = 'play';
    this.calibrate();
    this.app.toast('Punch the notes on the beat!\nBlue = left hand, pink = right hand', 3);
    if (this.isHost && !this.solo) this.app.sendGame('start', { seed, delay });
  }

  // ---------- music (generated live; no audio files) ----------

  scheduleMusic() {
    const ctx = this.ctx;
    if (!ctx) return;
    const horizon = this.songTime() + 0.25;
    while (this.scheduledBeat < SONG_BEATS + 4 && this.scheduledBeat * BEAT < horizon) {
      const b = this.scheduledBeat;
      const t = this.t0 + b * BEAT;
      if (t >= ctx.currentTime - 0.01) this.playBeat(b, t);
      this.scheduledBeat += 0.5;
    }
  }

  playBeat(b, t) {
    const onBeat = b % 1 === 0;
    const end = b >= SONG_BEATS;
    if (b < 0 || end) {
      if (onBeat && b < 0) this.click(t);
      return;
    }
    if (onBeat) this.kick(t);
    if (b >= 16 && onBeat && b % 2 === 1) this.snare(t);
    if (b >= 24) this.hat(t, onBeat ? 0.04 : 0.07);
    if (b >= 16 && b % 1 === 0) this.bass(t, midiHz(bassNote(Math.floor(b / 4), this.seed)), BEAT * 0.9);
    if (b >= 40) {
      const root = bassNote(Math.floor(b / 4), this.seed) + 24;
      const arp = [0, 7, 12, 15][Math.floor(b * 2) % 4];
      this.lead(t, midiHz(root + arp), BEAT * 0.4, b >= 96 ? 0.06 : 0.035);
    }
  }

  voice(t, type, f, f2, dur, vol, filter = null) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (filter) {
      const fl = ctx.createBiquadFilter();
      fl.type = 'lowpass';
      fl.frequency.value = filter;
      node = o.connect(fl);
    }
    node.connect(g).connect(this.app.sfx.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noiseHit(t, type, f, dur, vol) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.app.sfx.noiseBuf;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(fl).connect(g).connect(this.app.sfx.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  kick(t) { this.voice(t, 'sine', 150, 40, 0.22, 0.9); }
  snare(t) { this.noiseHit(t, 'bandpass', 1800, 0.15, 0.5); this.voice(t, 'triangle', 220, 120, 0.08, 0.2); }
  hat(t, vol) { this.noiseHit(t, 'highpass', 7000, 0.04, vol * 4); }
  bass(t, f, dur) { this.voice(t, 'sawtooth', f, null, dur, 0.22, 700); }
  lead(t, f, dur, vol) { this.voice(t, 'square', f, null, dur, vol, 3000); }
  click(t) { this.voice(t, 'square', 1500, null, 0.05, 0.12); }

  // ---------- gameplay ----------

  update(dt) {
    if (this.phase === 'wait' || !this.lanes) return;
    this.scheduleMusic();
    const st = this.songTime();
    const beat = st / BEAT;
    this.pulse = Math.max(0, 1 - ((beat % 1) + 1) % 1 * 4);
    this.grid.material.opacity = 0.25 + this.pulse * 0.35;

    for (const n of this.notes) {
      if (n.state !== 'pending') continue;
      const nt = n.beat * BEAT;
      const ahead = nt - st;
      if (ahead > AHEAD) break;
      if (!n.mesh) {
        n.mesh = new THREE.Mesh(this.noteGeo, n.extra ? this.noteMats.extra : this.noteMats[LANE_HAND[n.lane]]);
        this.root.add(n.mesh);
      }
      n.mesh.position.copy(this.lanes[n.lane]).add(_v.set(0, 0, -ahead * SPEED));
      if (Math.abs(ahead) <= WINDOW) {
        const hand = this.app.hand(LANE_HAND[n.lane]);
        if (hand && hand.pos.distanceTo(this.lanes[n.lane]) < 0.25 && hand.vel.length() > 0.6) this.hit(n, -ahead, hand);
      } else if (ahead < -WINDOW) this.miss(n);
    }
    // Keep the notes array sorted when attacks add notes.
    if (this.phase === 'play' && st > SONG_BEATS * BEAT + 2) this.finish();

    this.sendAcc += dt;
    if (!this.solo && this.sendAcc > 0.5) {
      this.sendAcc = 0;
      this.app.sendGame('score', { score: this.score, combo: this.combo }, false);
    }
    this.feedbackT -= dt;
    this.feedback.mesh.visible = this.feedbackT > 0;
    this.refreshBoard(st);
  }

  hit(n, dt, hand) {
    const j = judge(dt);
    if (!j) return;
    n.state = 'hit';
    this.root.remove(n.mesh);
    this.combo++;
    this.hits++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.score += j.points * multiplier(this.combo);
    this.app.particles.burst(n.mesh.position, n.extra ? 0xffee33 : HAND_HEX[LANE_HAND[n.lane]], 18, 2, 0.35);
    hand.pulse(j.rating === 'PERFECT' ? 0.8 : 0.5, 40);
    this.show(j.rating, j.rating === 'PERFECT' ? '#7dff8a' : '#ffffff');
    if (!this.solo && this.combo % ATTACK_EVERY === 0) {
      this.app.sendGame('attack', { beat: this.songTime() / BEAT });
      this.show('ATTACK SENT!', '#ffee33');
    }
  }

  miss(n) {
    n.state = 'miss';
    if (n.mesh) this.root.remove(n.mesh);
    this.combo = 0;
    this.misses++;
    this.show('MISS', '#ff6b6b');
  }

  show(text, color) {
    this.feedback.set(text, color);
    this.feedbackT = 0.45;
  }

  receiveAttack(beat) {
    const extra = attackNotes(beat + 4, this.seed).map((n) => ({ ...n, state: 'pending', mesh: null }));
    this.notes.push(...extra);
    this.notes.sort((a, b) => a.beat - b.beat);
    this.app.toast('INCOMING ATTACK! Extra yellow notes', 2);
    this.app.sfx.alarm();
  }

  finish() {
    this.phase = 'done';
    if (this.solo) {
      if (this.score > this.best) { this.best = this.score; localStorage.setItem(BEST_KEY, String(this.best)); }
      this.showResult();
      return;
    }
    this.app.sendGame('final', { score: this.score });
    this.showResult();
  }

  onNet(k, d) {
    if (k === 'join' && this.isHost && this.phase === 'wait') this.start(this.seed, START_DELAY);
    else if (k === 'start' && !this.isHost) this.start(d.seed, Math.max(0.5, d.delay - this.app.net.rtt / 2000));
    else if (k === 'score') { this.theirs.score = d.score; this.theirs.combo = d.combo; }
    else if (k === 'attack' && this.phase === 'play') this.receiveAttack(d.beat);
    else if (k === 'final') {
      this.theirs.final = d.score;
      this.theirs.score = d.score;
      if (this.phase === 'done') this.showResult();
    } else if (k === 'rematch' && this.isHost) this.app.requestGame('rhythm');
  }

  refreshBoard(st) {
    const left = Math.max(0, Math.ceil(SONG_BEATS * BEAT - st));
    const count = st < 0 ? `GET READY ${Math.ceil(-st)}\n` : '';
    const me = `YOU ${this.score.toLocaleString()}  x${multiplier(this.combo)}  (${this.combo})`;
    this.board.set(this.solo
      ? `${count}${me}\nBEST ${this.best.toLocaleString()}  ·  ${left}s`
      : `${count}${me}\nTHEM ${this.theirs.score.toLocaleString()}  ·  ${left}s`);
  }

  showResult() {
    if (!this.panel) {
      this.panel = this.app.ui.add(new Panel({ w: 1.1, h: 0.75, cols: 2 }));
      this.panel.mesh.position.set(this.app.rig.position.x, 1.5, -1.3);
      this.root.add(this.panel.mesh);
    }
    const waiting = !this.solo && this.theirs.final === null;
    const won = this.solo || this.score >= (this.theirs.final ?? 0);
    const acc = Math.round((100 * this.hits) / Math.max(1, this.hits + this.misses));
    this.panel.set({
      title: this.solo ? `${this.score.toLocaleString()} POINTS` : waiting ? 'Waiting for your rival…' : won ? 'YOU WIN!' : 'YOU LOSE',
      accent: won ? '#7dff8a' : '#ff6b6b',
      lines: [
        `Accuracy ${acc}%  ·  max combo ${this.maxCombo}`,
        this.solo ? `Best: ${this.best.toLocaleString()}` : `You ${this.score.toLocaleString()}  vs  them ${(this.theirs.final ?? this.theirs.score).toLocaleString()}`,
      ],
      buttons: [
        { label: 'Again', onClick: () => (this.isHost ? this.app.requestGame('rhythm') : this.app.sendGame('rematch')) },
        { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
      ],
    });
  }
}
