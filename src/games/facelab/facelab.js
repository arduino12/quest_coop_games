import * as THREE from 'three';
import { Game } from '../../core/game.js';
import { Panel, Label } from '../../core/ui3d.js';
import { glowMat, gridFloor } from '../../core/env.js';
import { Body } from '../../core/body.js';
import { parseFace, makeHead, applyCalib, loadCalib, saveCalib, placeholderHead, DEFAULT_CALIB, DEFAULT_COLOR, PLACEHOLDER_NECK } from '../../core/faces.js';

const MIRROR_Z = -0.75;
const BUST_EYES = new THREE.Vector3(0, 1.55, -0.9);
const FACE_PLAYER = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

// See your face scan in VR: on a pedestal (size, turn, nod, tilt, neck, auto-spin, body) or as the
// head of a mirror image that copies your movements. Saving keeps the calibration for your avatar.
export class FaceLab extends Game {
  constructor(app) {
    super(app);
    this.calib = loadCalib();
    this.mode = 'bust'; // bust | mirror
    this.spin = true;
    this.bodyOn = true;
    this.faceRef = null;
    this.info = null;
    this.grab = null;
    this.hasScan = false;
    this.x = app.role === 'guest' ? 0.7 : app.net.connected ? -0.7 : 0;

    this.buildStudio();
    app.setRig(this.x, 0, 0.3, 0);
    this.loadFace();
    this.refresh();
  }

  buildStudio() {
    const root = this.root;
    this.app.scene.background = new THREE.Color(0x14121c);
    root.add(new THREE.HemisphereLight(0xffffff, 0x302838, 1.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1, 3, 2);
    root.add(key);
    root.add(gridFloor(20, 40, 0x3a3060, 0.4));
    const x = this.x;
    // Pedestal, and the pose its head floats at (spins, can be grabbed).
    this.pedestal = new THREE.Group();
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.36, 32), new THREE.MeshLambertMaterial({ color: 0x2a2838 }));
    col.position.y = 0.68;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 8, 48), glowMat(0xb06bff));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1.37;
    this.pedestal.add(col, ring);
    this.pedestal.position.set(x, 0, BUST_EYES.z);
    root.add(this.pedestal);
    this.bust = new THREE.Group();
    this.bust.position.set(x, BUST_EYES.y, BUST_EYES.z);
    root.add(this.bust);
    this.bustBody = new Body(0x6a5acd);
    root.add(this.bustBody.group);
    // Mirror frame and the reflected world inside it.
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.3), new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.06, depthWrite: false }));
    frame.position.set(x, 1.2, MIRROR_Z - 0.01);
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.7, 2.3)), new THREE.LineBasicMaterial({ color: 0xb06bff }));
    border.position.copy(frame.position);
    this.mirrorFrame = new THREE.Group();
    this.mirrorFrame.add(frame, border);
    root.add(this.mirrorFrame);
    this.mirror = new THREE.Group();
    this.mirror.position.z = 2 * MIRROR_Z;
    this.mirror.scale.z = -1; // reflect everything placed in world coordinates inside it
    root.add(this.mirror);
    this.mirrorBody = new Body(0x6a5acd);
    this.mirror.add(this.mirrorBody.group);

    this.panel = this.app.ui.add(new Panel({ w: 1.0, h: 1.35, res: 768, cols: 3, accent: '#b06bff' }));
    this.panel.mesh.position.set(x + 0.95, 1.3, -0.55);
    this.panel.mesh.rotation.y = -0.75;
    root.add(this.panel.mesh);
    this.colorPanel = this.app.ui.add(new Panel({ w: 0.9, h: 0.85, res: 768, cols: 2, accent: '#ffb347' }));
    this.colorPanel.mesh.position.set(x - 0.95, 1.3, -0.55);
    this.colorPanel.mesh.rotation.y = 0.75;
    root.add(this.colorPanel.mesh);
    this.title = new Label('FACE LAB', { w: 1.2, h: 0.18, color: '#b06bff' });
    this.title.mesh.position.set(x, 2.45, -1.25);
    root.add(this.title.mesh);
  }

  async loadFace() {
    const face = this.app.myFace;
    this.faceRef = face;
    for (const b of [this.bustBody, this.mirrorBody]) b.headSlot.clear();
    this.inners = [];
    let model = null;
    this.info = null;
    if (face) {
      try {
        const res = await parseFace(face.bytes.slice(0));
        model = res.model;
        this.info = { name: face.name, triangles: res.triangles };
      } catch (e) {
        console.error(e);
        this.info = { error: 'Could not read that file' };
      }
    }
    this.hasScan = !!model;
    if (model) {
      const a = makeHead(model, this.calib);
      const b = makeHead(model.clone(), this.calib);
      this.bustBody.headSlot.add(a.head);
      this.mirrorBody.headSlot.add(b.head);
      this.inners = [a.inner, b.inner];
    } else {
      this.bustBody.headSlot.add(placeholderHead());
      this.mirrorBody.headSlot.add(placeholderHead());
    }
    this.applyNeck();
    this.refresh();
  }

  applyNeck() {
    const neck = this.hasScan ? this.calib.neck : PLACEHOLDER_NECK;
    this.bustBody.setNeck(neck);
    this.mirrorBody.setNeck(neck);
  }

  change(fn) {
    fn(this.calib);
    for (const inner of this.inners) applyCalib(inner, this.calib);
    this.applyNeck();
    this.app.sfx.click();
    this.refresh();
  }

  refresh() {
    this.refreshColor();
    const c = this.calib;
    const i = this.info;
    const lines = !this.faceRef
      ? ['No face scan on this headset yet.', 'On the start page press "Choose face file" and pick your .glb (for example arad01.glb).']
      : !i ? ['Loading your face…'] : i.error ? [i.error] : [
        `${i.name}  ·  ${Math.round(i.triangles / 1000)}k triangles`,
        `turn ${c.yaw}°  nod ${c.pitch}°  tilt ${c.roll}°  size ${Math.round(c.scale * 100)}%`,
        `height ${Math.round(c.lift * 100)} cm  ·  neck ${Math.round(c.neck * 100)} cm (0 if the scan has a neck)`,
      ];
    const step = 10;
    const cm = (v) => Math.round(v * 100) / 100;
    this.panel.set({
      title: this.mode === 'bust' ? 'Your scan' : 'Mirror: you, with your face',
      lines,
      buttons: [
        { label: 'Size −', onClick: () => this.change((k) => { k.scale = cm(k.scale / 1.1); }) },
        { label: 'Size +', onClick: () => this.change((k) => { k.scale = cm(k.scale * 1.1); }) },
        { label: 'Reset', onClick: () => this.change((k) => Object.assign(k, DEFAULT_CALIB)) },
        { label: 'Turn ⟲', onClick: () => this.change((k) => { k.yaw = (k.yaw + step) % 360; }) },
        { label: 'Turn ⟳', onClick: () => this.change((k) => { k.yaw = (k.yaw - step) % 360; }) },
        { label: `Spin: ${this.spin ? 'ON' : 'OFF'}`, onClick: () => { this.spin = !this.spin; this.bust.rotation.set(0, 0, 0); this.refresh(); } },
        { label: 'Nod ↑', onClick: () => this.change((k) => { k.pitch = (k.pitch + step) % 360; }) },
        { label: 'Nod ↓', onClick: () => this.change((k) => { k.pitch = (k.pitch - step) % 360; }) },
        { label: `Body: ${this.bodyOn ? 'ON' : 'OFF'}`, onClick: () => { this.bodyOn = !this.bodyOn; this.refresh(); } },
        { label: 'Tilt ↶', onClick: () => this.change((k) => { k.roll = (k.roll + step) % 360; }) },
        { label: 'Tilt ↷', onClick: () => this.change((k) => { k.roll = (k.roll - step) % 360; }) },
        { label: this.mode === 'bust' ? 'Mirror' : 'Pedestal', accent: '#7dff8a', onClick: () => { this.mode = this.mode === 'bust' ? 'mirror' : 'bust'; this.refresh(); } },
        { label: 'Raise', onClick: () => this.change((k) => { k.lift = cm(k.lift + 0.01); }) },
        { label: 'Lower', onClick: () => this.change((k) => { k.lift = cm(k.lift - 0.01); }) },
        { label: 'Neck −', onClick: () => this.change((k) => { k.neck = Math.max(0, cm(k.neck - 0.01)); }) },
        { label: 'Neck +', onClick: () => this.change((k) => { k.neck = Math.min(0.2, cm(k.neck + 0.01)); }) },
        { label: 'Save', accent: '#7dff8a', onClick: () => this.save() },
        { label: 'Menu', onClick: () => this.app.requestGame('lobby') },
      ],
    });
  }

  refreshColor() {
    const c = this.calib;
    const r2 = (v) => Math.round(v * 100) / 100;
    const sign = (v) => (v > 0 ? `+${v}` : `${v}`);
    this.colorPanel.set({
      title: 'Face color',
      lines: [`bright ${sign(r2(c.bright))}  contrast ${r2(c.contrast)}  color ${r2(c.sat)}  warm ${sign(r2(c.warm))}`],
      buttons: [
        { label: 'Darker', onClick: () => this.change((k) => { k.bright = r2(k.bright - 0.03); }) },
        { label: 'Brighter', onClick: () => this.change((k) => { k.bright = r2(k.bright + 0.03); }) },
        { label: 'Contrast −', onClick: () => this.change((k) => { k.contrast = r2(Math.max(0.5, k.contrast - 0.05)); }) },
        { label: 'Contrast +', onClick: () => this.change((k) => { k.contrast = r2(Math.min(2, k.contrast + 0.05)); }) },
        { label: 'Paler', onClick: () => this.change((k) => { k.sat = r2(Math.max(0, k.sat - 0.1)); }) },
        { label: 'More color', onClick: () => this.change((k) => { k.sat = r2(Math.min(2.5, k.sat + 0.1)); }) },
        { label: 'Cooler', onClick: () => this.change((k) => { k.warm = r2(Math.max(-0.3, k.warm - 0.02)); }) },
        { label: 'Warmer', onClick: () => this.change((k) => { k.warm = r2(Math.min(0.3, k.warm + 0.02)); }) },
        { label: 'Reset color', onClick: () => this.change((k) => Object.assign(k, DEFAULT_COLOR)) },
        { label: 'Save', accent: '#7dff8a', onClick: () => this.save() },
      ],
    });
  }

  save() {
    saveCalib(this.calib);
    this.app.faceShare?.sendCalib();
    this.app.toast('Saved: this is how your face sits on your avatar', 2.5);
    this.app.sfx.powerup();
  }

  updateGrab() {
    const app = this.app;
    app.hands.forEach((hand, i) => {
      if (!hand.connected) return;
      if (hand.state.squeeze.down && !this.grab && this.mode === 'bust' && hand.pos.distanceTo(this.bust.position) < 0.3) {
        // Hold the head: it follows your hand until you let go.
        const inv = hand.quat.clone().invert();
        this.grab = { i, offPos: this.bust.position.clone().sub(hand.pos).applyQuaternion(inv), offQuat: inv.multiply(this.bust.quaternion) };
        hand.pulse(0.3, 30);
      }
      if (this.grab && this.grab.i === i) {
        if (!hand.state.squeeze.pressed) this.grab = null;
        else {
          this.bust.position.copy(this.grab.offPos).applyQuaternion(hand.quat).add(hand.pos);
          this.bust.quaternion.copy(hand.quat).multiply(this.grab.offQuat);
        }
      }
    });
  }

  update(dt) {
    if (this.app.myFace !== this.faceRef) this.loadFace();
    const bust = this.mode === 'bust';
    this.pedestal.visible = bust && !this.bodyOn; // with a body, the head stands on its own shoulders
    this.bustBody.group.visible = bust;
    this.mirrorFrame.visible = this.mirror.visible = !bust;
    this.bustBody.setBodyVisible(this.bodyOn);
    this.mirrorBody.setBodyVisible(this.bodyOn);
    this.updateGrab();
    if (bust) {
      if (!this.grab && this.spin) this.bust.rotation.y += dt * 0.6;
      _q.copy(this.bust.quaternion).multiply(FACE_PLAYER);
      this.bustBody.update(this.bust.position, _q, [null, null]);
    } else {
      // Mirror: your own head and hands, reflected.
      const cam = this.app.camera;
      const hand = (h) => { const x = this.app.hand(h); return x ? x.pos.clone() : null; };
      this.mirrorBody.update(cam.getWorldPosition(_p), cam.getWorldQuaternion(_q), [hand('left'), hand('right')]);
    }
  }
}
