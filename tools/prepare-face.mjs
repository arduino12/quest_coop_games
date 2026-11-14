// Turns a textured face scan (OBJ + MTL + JPG/PNG, e.g. from EXStar) into a light GLB for the Quest.
//
//   npm run face -- "C:\path\to\scan.obj" [faces\name.glb] [--tris 50000]
//
// Converts millimetres to metres, centers the head, reduces the triangle count (meshoptimizer),
// keeps the photo texture and marks the material unlit (the scan's colors already include lighting).
// Output goes to faces/ by default, which git ignores: face scans are personal and are never committed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, basename, join, extname, resolve } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { simplify, weld, dedup, prune } from '@gltf-transform/functions';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const targetTris = Number(flag('--tris', 50000));
const unitScale = Number(flag('--scale', 0.001)); // scanner units -> metres (mm by default)
const [input, outArg] = args;
if (!input) {
  console.error('usage: npm run face -- <scan.obj> [out.glb] [--tris 50000] [--scale 0.001]');
  process.exit(1);
}
const out = resolve(outArg || join('faces', `${basename(input, extname(input))}.glb`));

// ---- parse the OBJ (positions, texture coordinates, faces) ----
const text = readFileSync(input, 'utf8');
const vs = [];
const vts = [];
const pos = [];
const uv = [];
const idx = [];
const corner = new Map();
let mtllib = null;
const cornerIndex = (tok) => {
  const [vi, ti] = tok.split('/');
  const key = `${vi}/${ti || ''}`;
  let k = corner.get(key);
  if (k === undefined) {
    const v = vs[(Number(vi) > 0 ? Number(vi) : vs.length + Number(vi) + 1) - 1];
    pos.push(v[0], v[1], v[2]);
    if (ti) {
      const t = vts[(Number(ti) > 0 ? Number(ti) : vts.length + Number(ti) + 1) - 1];
      uv.push(t[0], 1 - t[1]); // OBJ v goes up, glTF v goes down
    } else uv.push(0, 0);
    k = pos.length / 3 - 1;
    corner.set(key, k);
  }
  return k;
};
for (const line of text.split('\n')) {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'v') vs.push([Number(p[1]), Number(p[2]), Number(p[3])]);
  else if (p[0] === 'vt') vts.push([Number(p[1]), Number(p[2])]);
  else if (p[0] === 'f') {
    const c = p.slice(1).map(cornerIndex);
    for (let i = 1; i < c.length - 1; i++) idx.push(c[0], c[i], c[i + 1]);
  } else if (p[0] === 'mtllib') mtllib = line.trim().slice(7).trim();
}

// ---- metres, centered on the bounding box ----
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) {
  for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], pos[i + k]);
    max[k] = Math.max(max[k], pos[i + k]);
  }
}
const center = min.map((m, k) => (m + max[k]) / 2);
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] = (pos[i + k] - center[k]) * unitScale;

// ---- texture from the MTL (map_Kd) ----
let texture = null;
if (mtllib) {
  const mtlPath = join(dirname(input), mtllib);
  if (existsSync(mtlPath)) {
    const m = readFileSync(mtlPath, 'utf8').match(/map_Kd\s+(.+)/);
    if (m) {
      const texPath = join(dirname(input), m[1].trim());
      if (existsSync(texPath)) texture = { bytes: readFileSync(texPath), mime: /\.png$/i.test(texPath) ? 'image/png' : 'image/jpeg' };
    }
  }
}

// ---- build the glTF ----
const doc = new Document();
const buffer = doc.createBuffer();
const prim = doc.createPrimitive()
  .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
  .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer))
  .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer));
const unlit = doc.createExtension(KHRMaterialsUnlit);
const material = doc.createMaterial('face').setExtension('KHR_materials_unlit', unlit.createUnlit()).setDoubleSided(true);
if (texture) material.setBaseColorTexture(doc.createTexture('face').setImage(new Uint8Array(texture.bytes)).setMimeType(texture.mime));
prim.setMaterial(material);
const mesh = doc.createMesh('face').addPrimitive(prim);
doc.createScene('scene').addChild(doc.createNode('face').setMesh(mesh));

const before = idx.length / 3;
await MeshoptSimplifier.ready;
const ratio = Math.min(1, targetTris / before);
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002 }), dedup(), prune());
const after = prim.getIndices().getCount() / 3;

mkdirSync(dirname(out), { recursive: true });
await new NodeIO().registerExtensions([KHRMaterialsUnlit]).write(out, doc);
const size = (max[0] - min[0]) * unitScale, h = (max[1] - min[1]) * unitScale, d = (max[2] - min[2]) * unitScale;
console.log(`${basename(input)}: ${before} -> ${Math.round(after)} triangles, texture ${texture ? 'yes' : 'none'}`);
console.log(`size ${(size * 100).toFixed(1)} x ${(h * 100).toFixed(1)} x ${(d * 100).toFixed(1)} cm`);
console.log(`wrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
