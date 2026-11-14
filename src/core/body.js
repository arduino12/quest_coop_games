import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _h = new THREE.Vector3();

// Distance from the eyes down to the bottom of a head (where a neck starts).
export const HEAD_DROP = 0.12;

// A simple stylized body (neck, torso, shoulders, arms, hands) that follows a head pose and two hands.
//
// The head turns around the BASE of the neck, where it meets the shoulders: `joint` sits there and
// carries the head (put the head model in `headSlot`, eyes at its origin). So a scan that includes
// its own neck stays attached when you tilt your head; set neck = 0 for such scans.
export class Body {
  constructor(color = 0x5566aa) {
    this.neckLen = 0.08;
    this.bodyVisible = true;
    this.group = new THREE.Group();
    // A little self-glow keeps the body visible in scenes without lights.
    this.mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
    this.skin = new THREE.MeshLambertMaterial({ color: 0xc89a7a, emissive: 0x5a4436, side: THREE.DoubleSide });
    this.setColor(color);
    this.neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1, 12), this.skin);
    // Tapered chest (broad shoulders, narrower waist), flattened front to back.
    this.torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.56, 24), this.mat);
    this.torso.scale.set(1, 1, 0.6);
    this.shoulders = [0, 1].map(() => new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 12), this.mat));
    this.arms = [0, 1].map(() => new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 1, 10), this.mat));
    this.hands = [0, 1].map(() => new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), this.skin));
    this.joint = new THREE.Group(); // neck base: rotates with the head
    this.headSlot = new THREE.Group(); // eye position, relative to the joint
    this.joint.add(this.headSlot);
    this.parts = [this.neck, this.torso, ...this.shoulders, ...this.arms, ...this.hands];
    this.group.add(...this.parts, this.joint);
    this.setNeck(this.neckLen);
  }

  setColor(hex) {
    this.mat.color.set(hex);
    this.mat.emissive.set(hex).multiplyScalar(0.4);
  }

  setNeck(len) {
    this.neckLen = Math.max(0, len);
    this.headSlot.position.set(0, HEAD_DROP + this.neckLen, 0);
  }

  // Show or hide everything except the head.
  setBodyVisible(v) {
    this.bodyVisible = v;
    for (const p of this.parts) p.visible = v;
  }
  setHandsVisible(v) { for (const h of this.hands) h.visible = v; }

  // head: eye position + orientation; hands: [Vector3 | null, Vector3 | null] (left, right).
  update(headPos, headQuat, hands) {
    // The joint is where rotating the head about it puts the eyes exactly at headPos.
    const d = HEAD_DROP + this.neckLen;
    const base = _h.set(0, d, 0).applyQuaternion(headQuat).negate().add(headPos);
    this.joint.position.copy(base);
    this.joint.quaternion.copy(headQuat);

    _e.setFromQuaternion(headQuat, 'YXZ');
    const yaw = _e.y;
    _f.set(-Math.sin(yaw), 0, -Math.cos(yaw)); // facing direction on the floor
    _r.set(Math.cos(yaw), 0, -Math.sin(yaw)); // body's right
    // Neck: from the base to where the head starts, tilting with the head.
    this.neck.visible = this.bodyVisible && this.neckLen > 0.005;
    if (this.neck.visible) {
      const top = _a.set(0, this.neckLen, 0).applyQuaternion(headQuat);
      this.neck.position.copy(base).addScaledVector(top, 0.5);
      this.neck.scale.set(1, this.neckLen + 0.02, 1);
      this.neck.quaternion.copy(headQuat);
    }
    this.torso.position.copy(base).add(_a.set(0, -0.29, 0)).addScaledVector(_f, -0.03);
    this.torso.rotation.set(0, yaw, 0);
    [-1, 1].forEach((side, i) => {
      const shoulder = _a.copy(base).add(_b.set(0, -0.04, 0)).addScaledVector(_r, side * 0.2).addScaledVector(_f, -0.03);
      this.shoulders[i].position.copy(shoulder);
      const hand = hands[i] || _b.copy(shoulder).add(new THREE.Vector3(0, -0.55, 0)).addScaledVector(_f, 0.05);
      const arm = this.arms[i];
      const dir = hand.clone().sub(shoulder);
      const len = Math.max(0.05, dir.length());
      arm.position.copy(shoulder).addScaledVector(dir, 0.5);
      arm.scale.set(1, len, 1);
      arm.quaternion.setFromUnitVectors(UP, dir.normalize());
      this.hands[i].position.copy(hand);
    });
  }
}
