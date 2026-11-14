import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Body, HEAD_DROP } from '../src/core/body.js';

describe('body neck joint', () => {
  const eyes = new THREE.Vector3(0.3, 1.62, -0.4);
  const turns = [
    new THREE.Euler(0, 0, 0), new THREE.Euler(0, 1.2, 0), new THREE.Euler(0.4, -0.6, 0.3), new THREE.Euler(-0.5, 2.5, -0.4),
  ];

  it('keeps the eyes exactly on the headset for any head turn and neck length', () => {
    for (const neck of [0, 0.08, 0.15]) {
      for (const e of turns) {
        const body = new Body();
        body.setNeck(neck);
        const q = new THREE.Quaternion().setFromEuler(e);
        body.update(eyes, q, [null, null]);
        body.group.updateMatrixWorld(true);
        const p = body.headSlot.getWorldPosition(new THREE.Vector3());
        expect(p.distanceTo(eyes)).toBeLessThan(1e-6);
      }
    }
  });

  it('pivots at the base of the neck: tilting the head does not move the shoulders', () => {
    const body = new Body();
    body.setNeck(0);
    body.update(eyes, new THREE.Quaternion(), [null, null]);
    const base = body.joint.position.clone();
    expect(base.y).toBeCloseTo(eyes.y - HEAD_DROP);
    // Tilt the head 25 degrees sideways around that base: the eyes move, the base stays.
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.44);
    const tiltedEyes = new THREE.Vector3(0, HEAD_DROP, 0).applyQuaternion(tilt).add(base);
    body.update(tiltedEyes, tilt, [null, null]);
    expect(body.joint.position.distanceTo(base)).toBeLessThan(1e-6);
  });

  it('hides the extra neck when the scan has its own', () => {
    const body = new Body();
    body.setNeck(0);
    body.update(eyes, new THREE.Quaternion(), [null, null]);
    expect(body.neck.visible).toBe(false);
    body.setNeck(0.08);
    body.update(eyes, new THREE.Quaternion(), [null, null]);
    expect(body.neck.visible).toBe(true);
  });
});
