import * as THREE from 'three';

// xr-standard gamepad button indices. a = A/X, b = B/Y.
const BUTTONS = { trigger: 0, squeeze: 1, stick: 3, a: 4, b: 5 };
const FORWARD = new THREE.Vector3(0, 0, -1);
const _raw = new THREE.Vector3();
const _q = new THREE.Quaternion();

// One tracked controller (or tracked hand). All positions are world space.
export class Hand {
  constructor(renderer, index, rig) {
    this.index = index;
    this.ray = renderer.xr.getController(index); // target-ray space: aiming direction
    this.grip = renderer.xr.getControllerGrip(index); // grip space: where the hand holds things
    rig.add(this.ray, this.grip);

    this.source = null;
    this.handedness = index === 0 ? 'left' : 'right';
    this.pos = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.rayOrigin = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, -1);
    this.axes = new THREE.Vector2();
    this.fresh = true;
    this.state = {};
    for (const name of Object.keys(BUTTONS)) this.state[name] = { pressed: false, down: false, up: false, value: 0 };
    this.selectFlag = false;
    this.squeezeFlag = false;

    this.ray.addEventListener('connected', (e) => {
      this.source = e.data;
      this.handedness = e.data.handedness || this.handedness;
      this.fresh = true;
    });
    this.ray.addEventListener('disconnected', () => { this.source = null; });
    // Events work for both controllers and tracked hands (pinch = select).
    this.ray.addEventListener('selectstart', () => { this.selectFlag = true; });
    this.ray.addEventListener('selectend', () => { this.selectFlag = false; });
    this.ray.addEventListener('squeezestart', () => { this.squeezeFlag = true; });
    this.ray.addEventListener('squeezeend', () => { this.squeezeFlag = false; });

    // Default look: a small glowing "glove". Games may hide or recolor it.
    this.visual = new THREE.Group();
    this.visualMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 0.09), this.visualMat);
    palm.position.set(0, -0.01, 0.02);
    this.visual.add(palm);
    this.grip.add(this.visual);
  }

  get connected() { return !!this.source; }

  setColor(hex) { this.visualMat.color.set(hex); }

  update(dt) {
    this.grip.updateWorldMatrix(true, false);
    this.ray.updateWorldMatrix(true, false);
    this.prevPos.copy(this.pos);
    this.grip.getWorldPosition(this.pos);
    this.grip.getWorldQuaternion(this.quat);
    if (this.fresh || dt <= 0) {
      this.prevPos.copy(this.pos);
      this.vel.set(0, 0, 0);
      this.fresh = false;
    } else {
      _raw.subVectors(this.pos, this.prevPos).divideScalar(dt);
      this.vel.lerp(_raw, 0.6);
    }
    this.ray.getWorldPosition(this.rayOrigin);
    this.ray.getWorldQuaternion(_q);
    this.dir.copy(FORWARD).applyQuaternion(_q);

    const gp = this.source?.gamepad;
    for (const [name, idx] of Object.entries(BUTTONS)) {
      const s = this.state[name];
      const btn = gp?.buttons?.[idx];
      let value = btn ? btn.value : 0;
      if (name === 'trigger' && this.selectFlag) value = Math.max(value, 1);
      if (name === 'squeeze' && this.squeezeFlag) value = Math.max(value, 1);
      const pressed = (btn?.pressed && name !== 'trigger' && name !== 'squeeze')
        || value > (s.pressed ? 0.35 : 0.6);
      s.down = pressed && !s.pressed;
      s.up = !pressed && s.pressed;
      s.pressed = pressed;
      s.value = value;
    }
    if (gp?.axes?.length >= 4) this.axes.set(gp.axes[2], gp.axes[3]);
    else if (gp?.axes?.length >= 2) this.axes.set(gp.axes[0], gp.axes[1]);
    else this.axes.set(0, 0);
  }

  pulse(intensity = 0.5, ms = 40) {
    const h = this.source?.gamepad?.hapticActuators?.[0];
    try { h?.pulse?.(intensity, ms); } catch { /* not supported */ }
  }
}
