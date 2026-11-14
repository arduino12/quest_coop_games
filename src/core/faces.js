import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Your face scan lives only on your own device (IndexedDB in this browser). It is never uploaded
// to the site; later it can be sent directly to your partner over the peer-to-peer connection.
const DB = 'quest-coop-games';
const STORE = 'faces';
const CALIB_KEY = 'qcg-face-calib';

// How the scan is turned into a head: rotation (degrees), size and height offset.
// Defaults match EXStar scans, which come out with the face toward -y and the crown toward +x;
// lift drops the box center (about the nose) so the eyes sit where the headset is.
// neck is the length of the body's neck under the head: 0 when the scan includes its own neck.
export const DEFAULT_CALIB = { yaw: 90, pitch: 0, roll: 90, scale: 1, lift: -0.03, neck: 0 };

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function saveMyFace(name, bytes) {
  await tx('readwrite', (s) => s.put({ name, bytes }, 'mine'));
}

export async function loadMyFace() {
  try {
    return (await tx('readonly', (s) => s.get('mine'))) || null;
  } catch {
    return null;
  }
}

export async function removeMyFace() {
  await tx('readwrite', (s) => s.delete('mine'));
}

export function loadCalib() {
  try {
    return { ...DEFAULT_CALIB, ...JSON.parse(localStorage.getItem(CALIB_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_CALIB };
  }
}

export function saveCalib(c) {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(c)); } catch { /* private mode */ }
}

// Parses a GLB into a mesh group. Returns { model, triangles, size }.
export async function parseFace(bytes) {
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  const model = gltf.scene;
  let triangles = 0;
  model.traverse((o) => {
    if (!o.isMesh) return;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    o.material.side = THREE.DoubleSide; // mirrors flip triangle winding
  });
  const box = new THREE.Box3().setFromObject(model);
  return { model, triangles: Math.round(triangles), size: box.getSize(new THREE.Vector3()) };
}

// Wraps a face model so that, with the given calibration, it looks down -z (like a player's head)
// with its center at the group's origin. Returns { head, inner } where inner holds the calibration.
export function makeHead(model, calib) {
  const head = new THREE.Group();
  const inner = new THREE.Group();
  inner.add(model);
  head.add(inner);
  applyCalib(inner, calib);
  return { head, inner };
}

export function applyCalib(inner, c) {
  const d = THREE.MathUtils.degToRad;
  inner.rotation.set(d(c.pitch), d(c.yaw), d(c.roll), 'YXZ');
  inner.scale.setScalar(c.scale);
  inner.position.set(0, c.lift, 0);
}

// Stand-in head for players without a scan (eyes at the origin, looking down -z).
export const PLACEHOLDER_NECK = 0.08;
export function placeholderHead(color = 0xffffff) {
  const g = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), new THREE.MeshLambertMaterial({ color: 0x1b2036, emissive: 0x0e1020 }));
  skull.scale.set(0.9, 1.1, 1.05);
  skull.position.y = -0.02;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.045, 0.03), new THREE.MeshBasicMaterial({ color }));
  visor.position.set(0, 0, -0.1);
  g.add(skull, visor);
  g.userData.visor = visor;
  return g;
}

// ---- sending faces to your partner (peer-to-peer; never through the website) ----
// PeerJS JSON messages must stay under ~16 KB: 11 KB of bytes is ~15 KB as base64.
const CHUNK = 11 * 1024;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function splitFace(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK) chunks.push(toBase64(bytes.subarray(i, i + CHUNK)));
  return chunks;
}

export function joinFace(chunks) {
  const parts = chunks.map(fromBase64);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

// Shares my face with my partner when we connect (if allowed), and turns theirs into their avatar's head.
export class FaceShare {
  constructor(app) {
    this.app = app;
    this.allowed = localStorage.getItem('qcg-share-face') !== '0';
    this.incoming = null;
    this.sendTimer = null;
    const net = app.net;
    net.on('connect', () => this.sendMine());
    net.on('disconnect', () => { this.incoming = null; app.avatar.setFace(null); });
    net.on('faceMeta', (d) => { this.incoming = { ...d, chunks: [] }; });
    net.on('faceChunk', (d) => {
      if (!this.incoming || this.incoming.id !== d.id) return;
      this.incoming.chunks[d.i] = d.c;
    });
    net.on('faceDone', async (d) => {
      const inc = this.incoming;
      if (!inc || inc.id !== d.id || inc.chunks.filter(Boolean).length !== inc.n) return;
      this.incoming = null;
      try {
        const { model } = await parseFace(joinFace(inc.chunks));
        app.avatar.setFace(model, inc.calib);
      } catch (e) {
        console.warn('[face] could not use partner face', e);
      }
    });
    net.on('faceCalib', (d) => app.avatar.setCalib(d.calib));
    net.on('faceNone', () => app.avatar.setFace(null));
  }

  setAllowed(v) {
    this.allowed = v;
    try { localStorage.setItem('qcg-share-face', v ? '1' : '0'); } catch { /* ignore */ }
    this.sendMine();
  }

  // Sends my face in small pieces so game messages are not held up.
  sendMine() {
    const { app } = this;
    if (!app.net.connected) return;
    clearInterval(this.sendTimer);
    const face = app.myFace;
    if (!face || !this.allowed) { app.net.send('faceNone', {}); return; }
    const chunks = splitFace(face.bytes);
    const id = Math.random().toString(36).slice(2);
    app.net.send('faceMeta', { id, n: chunks.length, calib: loadCalib() });
    let i = 0;
    this.sendTimer = setInterval(() => {
      for (let k = 0; k < 4 && i < chunks.length; k++, i++) app.net.send('faceChunk', { id, i, c: chunks[i] });
      if (i >= chunks.length) {
        clearInterval(this.sendTimer);
        app.net.send('faceDone', { id });
      }
    }, 50);
  }

  sendCalib() {
    if (this.app.net.connected && this.app.myFace && this.allowed) this.app.net.send('faceCalib', { calib: loadCalib() });
  }
}
