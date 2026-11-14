import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// A simple stylized body (neck, torso, shoulders, arms, hands) that follows a head pose and two
// hand positions. Everything is in the parent's space (world space when added to the scene).
export class Body {
  constructor(color = 0x5566aa) {
    this.group = new THREE.Group();
    this.mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
    this.skin = new THREE.MeshLambertMaterial({ color: 0xc89a7a, side: THREE.DoubleSide });
    this.neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.14, 12), this.skin);
    // Tapered chest (broad shoulders, narrower waist), flattened front to back.
    this.torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.56, 24), this.mat);
    this.torso.scale.set(1, 1, 0.6);
    this.shoulders = [0, 1].map(() => new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 12), this.mat));
    this.arms = [0, 1].map(() => new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 1, 10), this.mat));
    this.hands = [0, 1].map(() => new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), this.skin));
    this.group.add(this.neck, this.torso, ...this.shoulders, ...this.arms, ...this.hands);
  }

  setColor(hex) { this.mat.color.set(hex); }

  // head: Vector3 + Quaternion; hands: [Vector3 | null, Vector3 | null] for left and right.
  update(headPos, headQuat, hands) {
    _e.setFromQuaternion(headQuat, 'YXZ');
    const yaw = _e.y;
    _f.set(-Math.sin(yaw), 0, -Math.cos(yaw)); // facing direction on the floor
    _r.set(Math.cos(yaw), 0, -Math.sin(yaw)); // body's right
    this.neck.position.copy(headPos).add(_a.set(0, -0.14, 0)).addScaledVector(_f, -0.02);
    this.torso.position.copy(headPos).add(_a.set(0, -0.49, 0)).addScaledVector(_f, -0.04);
    this.torso.rotation.set(0, yaw, 0);
    [-1, 1].forEach((side, i) => {
      const shoulder = _a.copy(headPos).add(_b.set(0, -0.25, 0)).addScaledVector(_r, side * 0.2).addScaledVector(_f, -0.04);
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
