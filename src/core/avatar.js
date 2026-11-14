import * as THREE from 'three';
import { SnapshotBuffer, ClockSync } from './sync.js';
import { Body } from './body.js';
import { makeHead, applyCalib, placeholderHead, PLACEHOLDER_NECK } from './faces.js';
import { INTERP_DELAY_MS } from '../config.js';

// The partner: a body with their face scan (or a stand-in head) and hands, smoothed from 30 Hz poses.
// Pose layout: [head(pos3,quat4), left(pos3,quat4), right(pos3,quat4)] in world space.
// `head` and `hands.left/right` are pose holders that games read and attach things to.
export class RemoteAvatar {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.head = new THREE.Group();
    this.hands = { left: new THREE.Group(), right: new THREE.Group() };
    this.body = new Body(0xffffff);
    this.defaultHead = placeholderHead();
    this.body.headSlot.add(this.defaultHead);
    this.body.setNeck(PLACEHOLDER_NECK);
    this.face = null;
    this.group.add(this.head, this.hands.left, this.hands.right, this.body.group);

    this.buf = new SnapshotBuffer({ stride: 7, quatOffset: 3 });
    this.clock = new ClockSync();
    this.out = [];
    this.flags = [1, 1];
  }

  setColor(hex) {
    this.body.setColor(hex);
    this.defaultHead.userData.visor.material.color.set(hex);
  }

  setVisible(v) { this.group.visible = v; }
  setHandDotsVisible(v) { this.body.setHandsVisible(v); }

  // Their face scan as the head (model: from parseFace; calib: their saved calibration). null = stand-in.
  setFace(model, calib = null) {
    if (this.face) this.body.headSlot.remove(this.face.head);
    this.face = null;
    if (model && calib) {
      this.face = makeHead(model, calib);
      this.body.headSlot.add(this.face.head);
    }
    this.defaultHead.visible = !this.face;
    this.body.setNeck(this.face ? calib.neck ?? 0 : PLACEHOLDER_NECK);
  }

  setCalib(calib) {
    if (!this.face) return;
    applyCalib(this.face.inner, calib);
    this.body.setNeck(calib.neck ?? 0);
  }

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
    if (o.some((v) => !Number.isFinite(v))) return;
    this.head.position.set(o[0], o[1], o[2]);
    this.head.quaternion.set(o[3], o[4], o[5], o[6]);
    this.hands.left.position.set(o[7], o[8], o[9]);
    this.hands.left.quaternion.set(o[10], o[11], o[12], o[13]);
    this.hands.right.position.set(o[14], o[15], o[16]);
    this.hands.right.quaternion.set(o[17], o[18], o[19], o[20]);
    this.hands.left.visible = !!this.flags[0];
    this.hands.right.visible = !!this.flags[1];
    this.body.update(this.head.position, this.head.quaternion, [
      this.flags[0] ? this.hands.left.position : null,
      this.flags[1] ? this.hands.right.position : null,
    ]);
  }
}
