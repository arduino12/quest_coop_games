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
export const DEFAULT_CALIB = { yaw: 90, pitch: 0, roll: 90, scale: 1, lift: -0.03 };

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
