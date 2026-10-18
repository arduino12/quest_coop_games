import * as THREE from 'three';

const _w = new THREE.Vector3();

// "Pull yourself along" locomotion used by climbing and zero-G games: while a hand grips an
// anchor point, the player's rig moves so that hand stays pinned to the anchor.
export class GrabMove {
  constructor(app) {
    this.app = app;
    this.anchor = null; // { hand, point: Vector3 }
    this.vel = new THREE.Vector3();
    this.prev = app.rig.position.clone();
  }

  get holding() { return !!this.anchor; }

  grab(hand, point) {
    this.anchor = { hand, point: point.clone() };
  }

  release(hand) {
    if (this.anchor && (hand === undefined || this.anchor.hand === hand)) this.anchor = null;
  }

  // Call once per frame after hands have updated. Returns the rig's velocity estimate.
  update(dt) {
    const rig = this.app.rig;
    if (this.anchor) {
      const hand = this.app.hands[this.anchor.hand];
      if (!hand.connected) this.anchor = null;
      else {
        rig.updateMatrixWorld(true);
        hand.grip.getWorldPosition(_w);
        rig.position.add(this.anchor.point.clone().sub(_w));
      }
    }
    if (dt > 0) this.vel.lerp(_w.subVectors(rig.position, this.prev).divideScalar(dt), 0.5);
    this.prev.copy(rig.position);
    return this.vel;
  }
}
