import * as THREE from 'three';

const _fwd = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// Left thumbstick moves the player relative to where they look. `clamp(rigPosition)` keeps them in bounds.
export function smoothMove(app, dt, { speed = 2, clamp = null } = {}) {
  const hand = app.hand('left');
  if (!hand) return;
  const ax = hand.axes.x, ay = hand.axes.y;
  if (Math.hypot(ax, ay) < 0.15) return;
  app.camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-6) return;
  _fwd.normalize();
  // right = forward x up
  const rx = -_fwd.z, rz = _fwd.x;
  const k = speed * dt;
  app.rig.position.x += (rx * ax - _fwd.x * ay) * k;
  app.rig.position.z += (rz * ax - _fwd.z * ay) * k;
  if (clamp) clamp(app.rig.position);
}

// Right thumbstick flick turns the player 45 degrees around their head.
export function snapTurn(app, state, angle = Math.PI / 4) {
  const hand = app.hand('right');
  const ax = hand ? hand.axes.x : 0;
  if (state.ready && Math.abs(ax) > 0.7) {
    state.ready = false;
    app.camera.getWorldPosition(_a);
    app.rig.rotation.y -= Math.sign(ax) * angle;
    app.rig.updateMatrixWorld(true);
    app.camera.getWorldPosition(_b);
    app.rig.position.x += _a.x - _b.x;
    app.rig.position.z += _a.z - _b.z;
    app.resetHandTracking();
  } else if (Math.abs(ax) < 0.3) {
    state.ready = true;
  }
}
