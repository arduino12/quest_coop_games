import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { smoothMove, snapTurn } from '../../core/locomotion.js';
import { starfield, edges, lineMat } from '../../core/env.js';
import { EntityBuffer, ClockSync, r3, r4 } from '../../core/sync.js';
import { COLORS, CSS_COLORS, INTERP_DELAY_MS } from '../../config.js';
import {
  ISLAND, BUDGET, BUILD_TIME, BATTLE_TIME, RELOAD, MAX_PULL, FALL_Y, GRAVITY, TYPE, BLOCKS,
  PLAYER_LOCAL, CRYSTAL_LOCAL, SLING_LOCAL, POUCH_LOCAL, DISPENSERS, BUILD_ZONE,
  CRYSTAL_ID, ID_BASE, PROJECTILE_BASE, ownerOfId, toWorldPos, toLocalPos, islandYaw,
  launchVelocity, trajectory, nearestAxisQuat, distToBox, premadeFort, timeoutWinner, onIsland,
} from './logic.js';

const STEP = 1 / 60;
const TRAJ_POINTS = 40;
const _v = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const _hp = new THREE.Vector3();
const _hq = new THREE.Quaternion();

const yawQuat = (side) => (side === 'host' ? [0, 0, 0, 1] : [0, 1, 0, 0]);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Build phase: each player simulates their own island and streams it to the other.
// Battle phase: the host simulates everything and streams all bodies; the guest only displays.
export class FortSiege extends Game {
  constructor(app) {
    super(app);
    this.mySide = app.mySide;
    this.otherSide = app.otherSide;
    this.isHost = app.role !== 'guest';
    this.solo = !app.net.connected;
    this.phase = 'build'; // build -> prep -> battle -> over
    this.timeLeft = BUILD_TIME;
    this.ready = { host: false, guest: false };
    this.winner = null;

    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = STEP;
    this.world.numSolverIterations = 8;
    this.simulating = true;
    this.acc = 0;

    this.bodies = new Map(); // simulated here: id -> { id, type, owner, body, mesh, age, lastSpeed }
    this.remote = new Map(); // displayed from snapshots: id -> { type, mesh }
    this.buf = new EntityBuffer({ quatOffset: 4 });
    this.clock = new ClockSync();
    this.nextId = ID_BASE[this.mySide];
    this.nextGuestId = ID_BASE.guest;
    this.nextProj = PROJECTILE_BASE;
    this.held = new Map(); // hand index -> { id, offPos, offQuat }
    this.sling = { hand: -1, reload: 0 };
    this.turnState = { ready: true };
    this.sendAcc = 0;
    this.hudAcc = 0;
    this.prepTimer = 0;

    this.makeAssets();
    this.buildWorld();
    this.buildSling();
    this.buildDispensers();
    this.buildHud();
    this.spawnCrystal(this.mySide);

    const p = toWorldPos(this.mySide, PLAYER_LOCAL);
    app.setRig(p[0], 0, p[2], islandYaw(this.mySide));
    app.toast('BUILD a fort around your crystal!\nSqueeze the grip on the shelf to your left', 5);
    if (!this.isHost) app.sendGame('join');
    this.refreshHud();
  }

  // ---------- setup ----------

  makeAssets() {
    const crystalGeo = new THREE.OctahedronGeometry(0.17, 0);
    crystalGeo.scale(1, 1.75, 1);
    this.geos = {
      [TYPE.cube]: new THREE.BoxGeometry(...BLOCKS[TYPE.cube].size),
      [TYPE.plank]: new THREE.BoxGeometry(...BLOCKS[TYPE.plank].size),
      [TYPE.pillar]: new THREE.BoxGeometry(...BLOCKS[TYPE.pillar].size),
      [TYPE.crystal]: crystalGeo,
      [TYPE.ball]: new THREE.SphereGeometry(BLOCKS[TYPE.ball].radius, 16, 12),
    };
    this.mats = {
      host: new THREE.MeshLambertMaterial({ color: 0x2c9fd0 }),
      guest: new THREE.MeshLambertMaterial({ color: 0xc8459f }),
      crystal_host: new THREE.MeshBasicMaterial({ color: COLORS.host }),
      crystal_guest: new THREE.MeshBasicMaterial({ color: COLORS.guest }),
      ball: new THREE.MeshLambertMaterial({ color: 0x2b2b38, emissive: 0x552200 }),
    };
  }

  makeMesh(type, owner) {
    let mat;
    if (type === TYPE.ball) mat = this.mats.ball;
    else if (type === TYPE.crystal) mat = this.mats[`crystal_${owner}`] || this.mats.crystal_host;
    else mat = this.mats[owner] || this.mats.host;
    const mesh = new THREE.Mesh(this.geos[type], mat);
    if (type === TYPE.crystal) mesh.add(edges(this.geos[type], 0xffffff, 0.8));
    this.root.add(mesh);
    return mesh;
  }

  buildWorld() {
    const app = this.app;
    const root = this.root;
    app.scene.background = new THREE.Color(0x0d0b24);
    app.scene.fog = new THREE.Fog(0x0d0b24, 35, 110);
    root.add(starfield(1000));
    root.add(new THREE.HemisphereLight(0x9fb0ff, 0x2a1838, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(6, 12, 4);
    root.add(sun);

    const H = ISLAND.half;
    const topGeo = new THREE.BoxGeometry(H * 2, 0.5, H * 2);
    const topMat = new THREE.MeshLambertMaterial({ color: 0x1f3347 });
    const rockGeo = new THREE.ConeGeometry(H * 1.25, 6, 7);
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x3a2c4a, flatShading: true });
    const postGeo = new THREE.CylinderGeometry(0.05, 0.07, 1.3, 8);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });

    for (const side of ['host', 'guest']) {
      const c = toWorldPos(side, [0, 0, 0]);
      const top = new THREE.Mesh(topGeo, topMat);
      top.position.set(c[0], -0.25, c[2]);
      root.add(top);
      const trim = edges(topGeo, COLORS[side], 0.8);
      trim.position.copy(top.position);
      root.add(trim);
      const rock = new THREE.Mesh(rockGeo, rockMat);
      rock.rotation.x = Math.PI;
      rock.position.set(c[0], -3.5, c[2]);
      root.add(rock);

      const zone = [
        [BUILD_ZONE.xMin, 0.02, BUILD_ZONE.zMin], [BUILD_ZONE.xMax, 0.02, BUILD_ZONE.zMin],
        [BUILD_ZONE.xMax, 0.02, BUILD_ZONE.zMax], [BUILD_ZONE.xMin, 0.02, BUILD_ZONE.zMax],
      ].map((l) => new THREE.Vector3(...toWorldPos(side, l)));
      root.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(zone), lineMat(COLORS[side], 0.5)));

      const islandBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c[0], -0.25, c[2]));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(H, 0.25, H).setFriction(1), islandBody);

      // Slingshot frame.
      for (const dx of [-0.3, 0.3]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(...toWorldPos(side, [SLING_LOCAL[0] + dx, 0.65, SLING_LOCAL[2]]));
        root.add(post);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.08), postMat);
      bar.position.set(...toWorldPos(side, [SLING_LOCAL[0], 0.35, SLING_LOCAL[2]]));
      root.add(bar);
      const slingBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
        .setTranslation(...toWorldPos(side, [SLING_LOCAL[0], 0.35, SLING_LOCAL[2]])));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.35, 0.35, 0.06), slingBody);
    }

    const abyss = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: 0x1a0b33 }));
    abyss.rotation.x = -Math.PI / 2;
    abyss.position.y = -60;
    root.add(abyss);
  }

  buildSling() {
    const side = this.mySide;
    this.pouchRest = new THREE.Vector3(...toWorldPos(side, POUCH_LOCAL));
    this.forkTips = [-0.3, 0.3].map((dx) => new THREE.Vector3(...toWorldPos(side, [SLING_LOCAL[0] + dx, 1.3, SLING_LOCAL[2]])));
    this.pouch = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.1), new THREE.MeshLambertMaterial({ color: 0x5a3a1b }));
    this.pouch.position.copy(this.pouchRest);
    this.root.add(this.pouch);
    this.ammo = new THREE.Mesh(this.geos[TYPE.ball], this.mats.ball);
    this.root.add(this.ammo);
    this.ammoGlow = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({
      color: 0xffb347, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.ammo.add(this.ammoGlow);
    this.bandPos = new Float32Array(12);
    const bg = new THREE.BufferGeometry();
    this.bandAttr = new THREE.BufferAttribute(this.bandPos, 3);
    bg.setAttribute('position', this.bandAttr);
    this.bands = new THREE.LineSegments(bg, lineMat(0xffd28a));
    this.bands.frustumCulled = false;
    this.root.add(this.bands);
    this.trajPos = new Float32Array(TRAJ_POINTS * 3);
    const tg = new THREE.BufferGeometry();
    this.trajAttr = new THREE.BufferAttribute(this.trajPos, 3);
    tg.setAttribute('position', this.trajAttr);
    this.traj = new THREE.Points(tg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.07, transparent: true, opacity: 0.8 }));
    this.traj.frustumCulled = false;
    this.traj.visible = false;
    this.root.add(this.traj);
  }

  buildDispensers() {
    this.dispensers = DISPENSERS.map((d) => {
      const world = new THREE.Vector3(...toWorldPos(this.mySide, d.local));
      const holo = new THREE.Mesh(this.geos[d.type], new THREE.MeshBasicMaterial({
        color: 0xffb347, wireframe: true, transparent: true, opacity: 0.85,
      }));
      holo.scale.setScalar(d.type === TYPE.plank ? 0.35 : 0.5);
      holo.position.copy(world);
      this.root.add(holo);
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.85, 10), new THREE.MeshLambertMaterial({ color: 0x334466 }));
      stand.position.set(world.x, 0.42, world.z);
      this.root.add(stand);
      return { type: d.type, world, holo };
    });
    const sign = new Label('BLOCKS', { w: 0.6, h: 0.14, color: '#ffb347' });
    const sp = toWorldPos(this.mySide, [-0.95, 1.45, 2.1]);
    sign.mesh.position.set(...sp);
    sign.mesh.rotation.y = islandYaw(this.mySide) + Math.PI / 2;
    this.root.add(sign.mesh);
  }

  buildHud() {
    this.hud = this.app.ui.add(new Panel({ w: 0.95, h: 0.7, accent: '#ffb347' }));
    this.hud.mesh.position.set(...toWorldPos(this.mySide, [1.95, 1.45, 1.95]));
    this.hud.mesh.rotation.y = islandYaw(this.mySide) - 0.9;
    this.root.add(this.hud.mesh);
  }

  // ---------- bodies ----------

  createBody(id, type, owner, pos, quat, vel = null) {
    const def = BLOCKS[type];
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setRotation({ x: quat[0], y: quat[1], z: quat[2], w: quat[3] })
      .setLinearDamping(0.05)
      .setAngularDamping(0.2);
    if (type === TYPE.ball) desc.setCcdEnabled(true);
    if (vel) desc.setLinvel(vel[0], vel[1], vel[2]);
    const body = this.world.createRigidBody(desc);
    let col;
    if (type === TYPE.ball) col = RAPIER.ColliderDesc.ball(def.radius);
    else if (type === TYPE.crystal) col = RAPIER.ColliderDesc.cylinder(def.size[1] / 2, def.size[0] / 2);
    else col = RAPIER.ColliderDesc.cuboid(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2);
    col.setDensity(def.density).setFriction(type === TYPE.ball ? 0.4 : 0.9).setRestitution(0.05);
    this.world.createCollider(col, body);
    const e = { id, type, owner, body, mesh: this.makeMesh(type, owner), age: 0, lastSpeed: vel ? Math.hypot(...vel) : 0 };
    this.bodies.set(id, e);
    return e;
  }

  removeBody(id) {
    const e = this.bodies.get(id);
    if (!e) return;
    for (const [i, h] of this.held) if (h.id === id) this.held.delete(i);
    this.world.removeRigidBody(e.body);
    this.root.remove(e.mesh);
    this.bodies.delete(id);
  }

  spawnCrystal(side) {
    this.createBody(CRYSTAL_ID[side], TYPE.crystal, side, toWorldPos(side, CRYSTAL_LOCAL), yawQuat(side));
  }

  blockCount() {
    let n = 0;
    for (const e of this.bodies.values()) if (e.owner === this.mySide && e.type <= TYPE.pillar) n++;
    return n;
  }

  entries(filter) {
    const out = [];
    for (const e of this.bodies.values()) {
      if (!filter(e)) continue;
      const t = e.body.translation();
      const r = e.body.rotation();
      out.push([e.id, e.type, r3(t.x), r3(t.y), r3(t.z), r4(r.x), r4(r.y), r4(r.z), r4(r.w)]);
    }
    return out;
  }

  // ---------- grabbing (build phase) ----------

  updateGrab() {
    const app = this.app;
    app.hands.forEach((hand, i) => {
      if (!hand.connected) return;
      if (this.held.has(i) && !hand.state.squeeze.pressed) { this.release(i); return; }
      if (!hand.state.squeeze.down || this.held.has(i) || this.sling.hand === i) return;
      let e = null;
      const disp = this.dispensers.find((d) => hand.pos.distanceTo(d.world) < 0.2);
      if (disp) {
        if (this.blockCount() >= BUDGET) {
          app.toast(`Block limit (${BUDGET}) reached.\nThrow blocks off the island to reuse them.`);
          return;
        }
        e = this.createBody(this.nextId++, disp.type, this.mySide, hand.pos.toArray(), yawQuat(this.mySide));
      } else e = this.nearestOwn(hand.pos);
      if (e) this.grab(i, e);
    });
  }

  nearestOwn(p) {
    let best = null;
    let bestD = 0.06;
    const pa = p.toArray();
    for (const e of this.bodies.values()) {
      if (e.owner !== this.mySide || e.type === TYPE.ball) continue;
      const t = e.body.translation();
      const r = e.body.rotation();
      const s = BLOCKS[e.type].size;
      const d = distToBox(pa, [t.x, t.y, t.z], [r.x, r.y, r.z, r.w], [s[0] / 2, s[1] / 2, s[2] / 2]);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  grab(i, e) {
    for (const [j, h] of this.held) if (h.id === e.id) this.held.delete(j);
    const hand = this.app.hands[i];
    e.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    const t = e.body.translation();
    const r = e.body.rotation();
    _qi.copy(hand.quat).invert();
    const offPos = new THREE.Vector3(t.x, t.y, t.z).sub(hand.pos).applyQuaternion(_qi);
    const offQuat = _qi.clone().multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    this.held.set(i, { id: e.id, offPos, offQuat });
    hand.pulse(0.4, 30);
    this.app.sfx.click();
  }

  release(i) {
    const h = this.held.get(i);
    this.held.delete(i);
    const e = h && this.bodies.get(h.id);
    if (!e) return;
    e.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const r = e.body.rotation();
    const snapped = nearestAxisQuat([r.x, r.y, r.z, r.w], 25);
    if (snapped) e.body.setRotation({ x: snapped[0], y: snapped[1], z: snapped[2], w: snapped[3] }, true);
    const v = this.app.hands[i].vel;
    e.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  releaseAll() {
    for (const i of [...this.held.keys()]) this.release(i);
  }

  updateHeld() {
    for (const [i, h] of this.held) {
      const e = this.bodies.get(h.id);
      if (!e) continue;
      const hand = this.app.hands[i];
      _hq.copy(hand.quat).multiply(h.offQuat);
      _hp.copy(h.offPos).applyQuaternion(hand.quat).add(hand.pos);
      e.body.setNextKinematicTranslation(_hp);
      e.body.setNextKinematicRotation(_hq);
    }
  }

  // ---------- slingshot ----------

  updateSling(dt) {
    const app = this.app;
    const s = this.sling;
    if (s.reload > 0) s.reload -= dt;
    const armed = this.phase === 'battle' && s.reload <= 0;
    let vel = null;
    if (s.hand >= 0) {
      const hand = app.hands[s.hand];
      if (!hand.connected || this.phase !== 'battle') s.hand = -1;
      else {
        _v.subVectors(hand.pos, this.pouchRest);
        if (_v.length() > MAX_PULL) _v.setLength(MAX_PULL);
        this.pouch.position.copy(this.pouchRest).add(_v);
        vel = launchVelocity(this.pouchRest.toArray(), this.pouch.position.toArray());
        if (!hand.state.squeeze.pressed) {
          s.hand = -1;
          if (vel) {
            this.fire(this.pouch.position.toArray(), vel);
            s.reload = RELOAD;
            hand.pulse(1, 80);
          }
          vel = null;
        }
      }
    }
    if (s.hand < 0) {
      this.pouch.position.copy(this.pouchRest);
      if (armed) {
        app.hands.forEach((h, i) => {
          if (s.hand < 0 && h.connected && h.state.squeeze.down && !this.held.has(i) && h.pos.distanceTo(this.pouchRest) < 0.25) {
            s.hand = i;
            h.pulse(0.4, 30);
            app.sfx.click();
          }
        });
      }
    }
    this.ammo.visible = armed || s.hand >= 0;
    this.ammo.position.copy(this.pouch.position);
    this.ammoGlow.visible = armed && s.hand < 0;

    const p = this.pouch.position;
    this.bandPos.set([this.forkTips[0].x, this.forkTips[0].y, this.forkTips[0].z, p.x, p.y, p.z,
      this.forkTips[1].x, this.forkTips[1].y, this.forkTips[1].z, p.x, p.y, p.z]);
    this.bandAttr.needsUpdate = true;

    this.traj.visible = !!vel;
    if (vel) {
      const pts = trajectory(p.toArray(), vel, TRAJ_POINTS, 0.06);
      for (let i = 0; i < TRAJ_POINTS; i++) {
        const q = pts[Math.min(i, pts.length - 1)];
        this.trajPos[i * 3] = q[0]; this.trajPos[i * 3 + 1] = q[1]; this.trajPos[i * 3 + 2] = q[2];
      }
      this.trajAttr.needsUpdate = true;
    }
  }

  fire(p, v) {
    this.app.sfx.whoosh(p);
    if (this.isHost) this.spawnProjectile(p, v, this.mySide);
    else this.app.sendGame('fire', { p, v });
  }

  spawnProjectile(p, v, owner) {
    this.createBody(this.nextProj++, TYPE.ball, owner, p, [0, 0, 0, 1], v);
  }

  // ---------- phases ----------

  toggleReady() {
    if (this.phase !== 'build') return;
    this.ready[this.mySide] = !this.ready[this.mySide];
    if (!this.solo) this.app.sendGame('ready', { side: this.mySide, v: this.ready[this.mySide] });
    this.refreshHud();
  }

  requestBattle() {
    if (this.phase !== 'build') return;
    this.releaseAll();
    this.phase = 'prep';
    if (this.solo) {
      this.spawnPremade();
      this.beginBattle();
      return;
    }
    this.prepTimer = 4;
    this.app.sendGame('layoutReq');
    this.refreshHud();
  }

  spawnPremade() {
    this.spawnCrystal('guest');
    for (const b of premadeFort()) {
      this.createBody(this.nextGuestId++, b.type, 'guest', toWorldPos('guest', b.local), yawQuat('guest'));
    }
  }

  adoptLayout(list) {
    for (const r of this.remote.values()) this.root.remove(r.mesh);
    this.remote.clear();
    this.buf.clear();
    for (const [id, type, x, y, z, qx, qy, qz, qw] of list) {
      if (this.bodies.has(id)) continue;
      this.createBody(id, type, 'guest', [x, y, z], [qx, qy, qz, qw]);
    }
  }

  // Fallback if the guest's layout never arrives: use what we last saw of their island.
  adoptFromRemote() {
    const list = [];
    for (const [id, r] of this.remote) {
      const p = r.mesh.position, q = r.mesh.quaternion;
      list.push([id, r.type, p.x, p.y, p.z, q.x, q.y, q.z, q.w]);
    }
    this.adoptLayout(list);
  }

  beginBattle() {
    this.phase = 'battle';
    this.timeLeft = BATTLE_TIME;
    this.app.sendGame('phase', { phase: 'battle', time: BATTLE_TIME });
    this.onBattleStart();
  }

  onBattleStart() {
    this.sling.reload = 1;
    this.app.toast('BATTLE!\nGrab the slingshot pouch, pull back, let go', 4);
    this.app.sfx.powerup();
    this.refreshHud();
  }

  finish(winner) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.winner = winner;
    if (!this.solo) this.app.sendGame('over', { winner });
    this.onOver();
  }

  finishByTime() {
    const counts = { host: 0, guest: 0 };
    for (const e of this.bodies.values()) {
      if (e.type > TYPE.pillar) continue;
      const t = e.body.translation();
      if (onIsland(e.owner, [t.x, t.y, t.z])) counts[e.owner]++;
    }
    this.finish(timeoutWinner(counts));
  }

  onOver() {
    const w = this.winner;
    const text = w === 'draw' ? "Time's up: it's a draw!" : w === this.mySide ? 'YOU WIN!\nTheir crystal is gone!' : 'You lost your crystal…';
    this.app.toast(text, 5);
    this.app.sfx.goal(w === this.mySide);
    this.refreshHud();
  }

  updateTimers(dt) {
    if (this.phase === 'build' || this.phase === 'battle') this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (!this.isHost) return;
    if (this.phase === 'build') {
      if (this.timeLeft <= 0 || (this.ready.host && (this.solo || this.ready.guest))) this.requestBattle();
    } else if (this.phase === 'prep') {
      this.prepTimer -= dt;
      if (this.prepTimer <= 0) {
        this.adoptFromRemote();
        this.beginBattle();
      }
    } else if (this.phase === 'battle' && this.timeLeft <= 0) this.finishByTime();
  }

  // ---------- networking ----------

  onNet(k, d) {
    switch (k) {
      case 'join':
        if (this.isHost) this.app.sendGame('sync', { phase: this.phase, time: this.timeLeft, ready: this.ready });
        break;
      case 'sync':
        this.timeLeft = d.time;
        this.ready = d.ready;
        break;
      case 'ready':
        this.ready[d.side] = d.v;
        this.refreshHud();
        break;
      case 'bodies':
        if (this.isHost && this.phase !== 'build') return;
        this.clock.update(d.ts, performance.now());
        this.buf.push(d.ts, d.e);
        break;
      case 'layoutReq':
        if (this.isHost) return;
        this.releaseAll();
        this.phase = 'prep';
        this.simulating = false;
        this.app.sendGame('layout', { e: this.entries((e) => e.owner === this.mySide) });
        this.refreshHud();
        break;
      case 'layout':
        if (!this.isHost || this.phase !== 'prep') return;
        this.adoptLayout(d.e);
        this.beginBattle();
        break;
      case 'phase':
        if (this.isHost || d.phase !== 'battle') return;
        // From now on the host simulates everything; our blocks become display-only.
        for (const e of this.bodies.values()) {
          this.world.removeRigidBody(e.body);
          if (this.remote.has(e.id)) this.root.remove(e.mesh);
          else this.remote.set(e.id, { type: e.type, mesh: e.mesh });
        }
        this.bodies.clear();
        this.held.clear();
        this.simulating = false;
        this.phase = 'battle';
        this.timeLeft = d.time;
        this.onBattleStart();
        break;
      case 'fire':
        if (this.isHost && this.phase === 'battle') this.spawnProjectile(d.p, d.v, 'guest');
        break;
      case 'fx':
        this.impactFx(d.p);
        break;
      case 'over':
        if (this.isHost) return;
        this.phase = 'over';
        this.winner = d.winner;
        this.onOver();
        break;
      default:
    }
  }

  netSend(dt) {
    if (this.solo) return;
    this.sendAcc += dt;
    const hz = this.phase === 'build' ? 10 : 15;
    if (this.sendAcc < 1 / hz) return;
    this.sendAcc = 0;
    const ts = performance.now();
    if (this.phase === 'build') {
      this.app.sendGame('bodies', { ts, e: this.entries((e) => e.owner === this.mySide) }, false);
    } else if (this.isHost && (this.phase === 'battle' || this.phase === 'over')) {
      this.app.sendGame('bodies', { ts, e: this.entries(() => true) }, false);
    }
  }

  applyRemote() {
    if (!this.buf.size) return;
    const map = this.buf.sample(this.clock.remoteNow(performance.now()) - INTERP_DELAY_MS);
    if (!map) return;
    for (const [id, v] of map) {
      if (this.bodies.has(id)) continue;
      let r = this.remote.get(id);
      if (!r) {
        r = { type: v[0], mesh: this.makeMesh(v[0], ownerOfId(id)) };
        this.remote.set(id, r);
      }
      r.mesh.position.set(v[1], v[2], v[3]);
      r.mesh.quaternion.set(v[4], v[5], v[6], v[7]);
    }
    for (const [id, r] of this.remote) {
      if (!map.has(id)) {
        this.root.remove(r.mesh);
        this.remote.delete(id);
      }
    }
  }

  // ---------- per-frame ----------

  update(dt, t) {
    this.locomote(dt);
    if (this.phase === 'build') this.updateGrab();
    this.updateSling(dt);
    this.updateTimers(dt);
    if (this.simulating) this.stepPhysics(dt);
    for (const e of this.bodies.values()) {
      const p = e.body.translation();
      const q = e.body.rotation();
      e.mesh.position.set(p.x, p.y, p.z);
      e.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
    this.netSend(dt);
    this.applyRemote();
    if (this.phase === 'build') this.buildChecks();
    if (this.isHost && (this.phase === 'battle' || this.phase === 'over')) this.battleChecks(dt);
    this.animate(t);
    this.hudAcc -= dt;
    if (this.hudAcc <= 0) {
      this.hudAcc = 0.25;
      this.refreshHud();
    }
  }

  locomote(dt) {
    const side = this.mySide;
    smoothMove(this.app, dt, {
      speed: 2,
      clamp: (p) => {
        const l = toLocalPos(side, [p.x, p.y, p.z]);
        l[0] = THREE.MathUtils.clamp(l[0], -2.7, 2.7);
        l[2] = THREE.MathUtils.clamp(l[2], -2.7, 2.8);
        const w = toWorldPos(side, l);
        p.x = w[0];
        p.z = w[2];
      },
    });
    snapTurn(this.app, this.turnState);
  }

  stepPhysics(dt) {
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n < 3) {
      this.updateHeld();
      this.world.step();
      this.acc -= STEP;
      n++;
    }
    if (n === 3) this.acc = 0;
  }

  buildChecks() {
    for (const e of [...this.bodies.values()]) {
      if (e.owner !== this.mySide) continue;
      const y = e.body.translation().y;
      if (e.type === TYPE.crystal && y < -3) {
        const p = toWorldPos(this.mySide, CRYSTAL_LOCAL);
        e.body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
        e.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this.app.toast('Your crystal fell! It is back in the middle.');
      } else if (e.type !== TYPE.crystal && y < -10) this.removeBody(e.id);
    }
  }

  battleChecks(dt) {
    for (const e of [...this.bodies.values()]) {
      const t = e.body.translation();
      if (e.type === TYPE.ball) {
        e.age += dt;
        const v = e.body.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        if (e.lastSpeed - sp > 6) {
          const p = [t.x, t.y, t.z];
          this.impactFx(p);
          if (!this.solo) this.app.sendGame('fx', { p });
        }
        e.lastSpeed = sp;
        if (t.y < -40 || e.age > 14) this.removeBody(e.id);
      } else if (t.y < -40) this.removeBody(e.id);
    }
    if (this.phase !== 'battle') return;
    for (const side of ['host', 'guest']) {
      const c = this.bodies.get(CRYSTAL_ID[side]);
      if (c && c.body.translation().y < FALL_Y) {
        this.finish(side === 'host' ? 'guest' : 'host');
        return;
      }
    }
  }

  impactFx(p) {
    this.app.particles.burst(p, 0xffb347, 30, 4, 0.6, 6);
    this.app.sfx.thunk(p);
  }

  animate(t) {
    for (const [i, d] of this.dispensers.entries()) {
      d.holo.rotation.y = t * 0.8 + i;
      d.holo.visible = this.phase === 'build';
      const near = this.app.hands.some((h) => h.connected && h.pos.distanceTo(d.world) < 0.2);
      d.holo.material.color.set(near ? 0xffffff : 0xffb347);
    }
    this.ammoGlow.scale.setScalar(1 + Math.sin(t * 6) * 0.15);
  }

  refreshHud() {
    const p = this.hud;
    if (this.phase === 'build') {
      p.set({
        title: 'BUILD PHASE',
        accent: '#ffb347',
        lines: [
          `Time left ${mmss(this.timeLeft)}   ·   Blocks ${this.blockCount()}/${BUDGET}`,
          this.solo ? 'Solo: press Ready when your fort is done.' : `Partner: ${this.ready[this.otherSide] ? 'READY ✓' : 'still building…'}`,
          'Squeeze grip to grab. Protect the crystal!',
        ],
        buttons: [{ label: this.ready[this.mySide] ? 'Wait, not ready' : "I'm ready!", onClick: () => this.toggleReady() }],
      });
    } else if (this.phase === 'prep') {
      p.set({ title: 'GET READY…', lines: ['Loading the battlefield.'], buttons: [] });
    } else if (this.phase === 'battle') {
      p.set({
        title: 'BATTLE!',
        accent: '#ff6b6b',
        lines: [
          `Time left ${mmss(this.timeLeft)}`,
          this.sling.reload > 0 ? 'Reloading…' : 'Slingshot ready!',
          'Pull the pouch back, aim with the arc, let go. Knock their crystal off!',
        ],
        buttons: [],
      });
    } else {
      const w = this.winner;
      p.set({
        title: w === 'draw' ? 'DRAW' : w === this.mySide ? 'VICTORY!' : 'DEFEAT',
        accent: w === this.mySide ? '#7dff8a' : CSS_COLORS[this.otherSide],
        lines: [w === 'draw' ? 'Both forts survived the clock.' : w === this.mySide ? 'You knocked their crystal off!' : 'Your crystal fell.'],
        cols: 2,
        buttons: [
          { label: 'Rematch', onClick: () => this.app.requestGame('fortsiege') },
          { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
        ],
      });
    }
  }

  dispose() {
    super.dispose();
    this.world.free();
  }
}
