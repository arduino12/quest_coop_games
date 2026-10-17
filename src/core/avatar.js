import * as THREE from 'three';
import { SnapshotBuffer, ClockSync } from './sync.js';
import { INTERP_DELAY_MS } from '../config.js';

// The partner's head and hands, smoothed from 30 Hz pose packets.
// Pose layout: [head(pos3,quat4), left(pos3,quat4), right(pos3,quat4)] in world space.
export class RemoteAvatar {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const dark = new THREE.MeshBasicMaterial({ color: 0x0b0e1e });

    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), dark);
    skull.scale.set(1, 1.1, 1.05);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.045, 0.03), this.mat);
    visor.position.set(0, 0.01, -0.1);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.006, 6, 32), this.mat);
    ring.rotation.x = Math.PI / 2;
    this.head.add(skull, visor, ring);

    this.torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.11, 0.5, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.25 }),
    );
    this.torsoMat = this.torso.material;

    this.hands = { left: new THREE.Group(), right: new THREE.Group() };
    this.handDots = [];
    for (const h of Object.values(this.hands)) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), this.mat);
      h.add(dot);
      this.handDots.push(dot);
    }
    this.group.add(this.head, this.torso, this.hands.left, this.hands.right);

    this.buf = new SnapshotBuffer({ stride: 7, quatOffset: 3 });
    this.clock = new ClockSync();
    this.out = [];
    this.flags = [1, 1];
    this._e = new THREE.Euler();
  }

  setColor(hex) {
    this.mat.color.set(hex);
    this.torsoMat.color.set(hex);
  }

  setVisible(v) { this.group.visible = v; }
  setHandDotsVisible(v) { for (const d of this.handDots) d.visible = v; }

  reset() {
    this.buf.clear();
    this.clock = new ClockSync();
  }

  push(ts, pose, flags) {
    this.clock.update(ts, performance.now());
    this.buf.push(ts, pose);
    if (flags) this.flags = flags;
  }

  update() {
    if (!this.buf.size) return;
    const t = this.clock.remoteNow(performance.now()) - INTERP_DELAY_MS;
    const o = this.buf.sample(t, this.out);
    this.head.position.set(o[0], o[1], o[2]);
    this.head.quaternion.set(o[3], o[4], o[5], o[6]);
    this._e.setFromQuaternion(this.head.quaternion, 'YXZ');
    this.torso.position.set(o[0], o[1] - 0.45, o[2]);
    this.torso.rotation.set(0, this._e.y, 0);
    this.hands.left.position.set(o[7], o[8], o[9]);
    this.hands.left.quaternion.set(o[10], o[11], o[12], o[13]);
    this.hands.right.position.set(o[14], o[15], o[16]);
    this.hands.right.quaternion.set(o[17], o[18], o[19], o[20]);
    this.hands.left.visible = !!this.flags[0];
    this.hands.right.visible = !!this.flags[1];
  }
}
