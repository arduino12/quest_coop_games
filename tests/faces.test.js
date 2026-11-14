import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeHead, applyCalib, addColorCorrection, DEFAULT_CALIB, splitFace, joinFace } from '../src/core/faces.js';

describe('face color correction', () => {
  it('feeds the calibration colors into the shader uniforms, live', () => {
    const mat = new THREE.MeshBasicMaterial();
    addColorCorrection(mat);
    const { inner } = makeHead(new THREE.Mesh(new THREE.BoxGeometry(), mat), DEFAULT_CALIB);
    const cc = mat.userData.cc;
    expect(cc.uSat.value).toBe(DEFAULT_CALIB.sat);
    applyCalib(inner, { ...DEFAULT_CALIB, bright: 0.1, contrast: 1.4, sat: 0.5, warm: -0.1 });
    expect([cc.uBright.value, cc.uContrast.value, cc.uSat.value, cc.uWarm.value]).toEqual([0.1, 1.4, 0.5, -0.1]);
  });

  it('patches the shader once, with a stable cache key', () => {
    const mat = new THREE.MeshBasicMaterial();
    addColorCorrection(mat);
    const first = mat.onBeforeCompile;
    addColorCorrection(mat);
    expect(mat.onBeforeCompile).toBe(first);
    const shader = { uniforms: {}, fragmentShader: 'void main(){\n#include <map_fragment>\n}' };
    mat.onBeforeCompile(shader);
    expect(shader.uniforms.uWarm).toBe(mat.userData.cc.uWarm);
    expect(shader.fragmentShader).toContain('uniform float uContrast;');
    expect(shader.fragmentShader).toContain('mix(vec3(l), c, uSat)');
  });
});

describe('sending faces in pieces', () => {
  it('splits into chunks small enough for one message and joins back exactly', () => {
    const bytes = new Uint8Array(100000).map((_, i) => (i * 31) % 256);
    const chunks = splitFace(bytes.buffer);
    expect(chunks.every((c) => c.length < 16000)).toBe(true);
    expect(new Uint8Array(joinFace(chunks))).toEqual(bytes);
  });
});
