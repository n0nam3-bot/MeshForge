import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const meta = {
  id: 'meshRepair',
  name: 'Add Mesh (Repair)',
  icon: '⬡',
  section: 'tools',
  description: 'Weld duplicate vertices, remove degenerate triangles, and fill small holes.',
  requires: ['hasGeometry'],
  requiresLabel: 'Needs a model first',
};

// Integer rounding + default toString avoids a subtle bug: toFixed() keeps
// the sign of a negative value even when it rounds to zero magnitude (e.g.
// cos(2*PI) landing on -2e-16 instead of exactly 0), which would otherwise
// silently split identical positions into different canonical ids on any
// mesh symmetric around an axis. Verified in test_holefill.mjs.
const PRECISION = 10000;
function posKey(x, y, z) {
  return `${Math.round(x * PRECISION)}_${Math.round(y * PRECISION)}_${Math.round(z * PRECISION)}`;
}

export function removeDegenerateTriangles(geometry) {
  const geo = geometry.index ? geometry : geometry.toNonIndexed();
  const pos = geo.attributes.position;
  const idx = geo.index ? geo.index.array : null;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cross = new THREE.Vector3();
  const keep = [];
  const triCount = idx ? idx.length / 3 : pos.count / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    e1.subVectors(b, a); e2.subVectors(c, a);
    cross.crossVectors(e1, e2);
    if (cross.length() * 0.5 > 1e-8) keep.push(i0, i1, i2);
  }
  const removed = triCount - keep.length / 3;
  const out = geo.clone();
  out.setIndex(keep);
  return { geometry: out, removed };
}

// Boundary-loop detection + fan-triangulated capping - validated in
// test_holefill.mjs against an open-ended cylinder (2 clean loops, correctly
// closes to 0 remaining boundary edges with outward-consistent cap normals).
function fillHoles(geometry, maxLoopLen = 500) {
  const geo = geometry.index ? geometry : geometry.toNonIndexed();
  if (!geo.index) return { geometry: geo, holesFilled: 0 };
  const pos = geo.attributes.position;
  const index = geo.index.array;
  const triCount = index.length / 3;

  const canonicalId = new Map();
  const posKeyOf = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = posKey(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (!canonicalId.has(k)) canonicalId.set(k, canonicalId.size);
    posKeyOf[i] = canonicalId.get(k);
  }
  const representative = new Map();
  for (let i = 0; i < pos.count; i++) if (!representative.has(posKeyOf[i])) representative.set(posKeyOf[i], i);

  const directedCount = new Map();
  const dkey = (a, b) => `${a}>${b}`;
  for (let t = 0; t < triCount; t++) {
    const a = posKeyOf[index[t * 3]], b = posKeyOf[index[t * 3 + 1]], c = posKeyOf[index[t * 3 + 2]];
    for (const [v1, v2] of [[a, b], [b, c], [c, a]]) directedCount.set(dkey(v1, v2), (directedCount.get(dkey(v1, v2)) || 0) + 1);
  }
  const boundaryNext = new Map();
  for (const [k] of directedCount) {
    const [v1, v2] = k.split('>').map(Number);
    if (!directedCount.has(dkey(v2, v1))) boundaryNext.set(v1, v2);
  }

  const visited = new Set();
  const loops = [];
  for (const start of boundaryNext.keys()) {
    if (visited.has(start)) continue;
    const loop = [start];
    visited.add(start);
    let cur = start, steps = 0, closed = false;
    while (steps++ < maxLoopLen) {
      const next = boundaryNext.get(cur);
      if (next === undefined) break;
      if (next === start) { closed = true; break; }
      if (visited.has(next)) break;
      loop.push(next);
      visited.add(next);
      cur = next;
    }
    if (closed && loop.length >= 3) loops.push(loop);
  }

  const newPositions = [];
  const newIndices = [];
  for (let i = 0; i < pos.count; i++) newPositions.push(pos.getX(i), pos.getY(i), pos.getZ(i));

  for (const loop of loops) {
    const pts = loop.map((cid) => new THREE.Vector3().fromBufferAttribute(pos, representative.get(cid)));
    const centroid = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const centroidIdx = newPositions.length / 3;
    newPositions.push(centroid.x, centroid.y, centroid.z);
    for (let i = 0; i < loop.length; i++) {
      const aRep = representative.get(loop[i]);
      const bRep = representative.get(loop[(i + 1) % loop.length]);
      // reversed order relative to the boundary walk - this is what actually
      // cancels the original boundary edge into an interior edge (verified;
      // the "same order" version left the mesh open, see test_holefill.mjs)
      newIndices.push(bRep, aRep, centroidIdx);
    }
  }

  const outPositions = new Float32Array(newPositions);
  const outIndex = new Uint32Array(index.length + newIndices.length);
  outIndex.set(index, 0);
  outIndex.set(newIndices, index.length);

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPositions, 3));
  out.setIndex(Array.from(outIndex));
  return { geometry: out, holesFilled: loops.length };
}

export function buildPanel(container, ctx, apply) {
  let vertsBefore = 0, trisBefore = 0;
  ctx.model?.traverse((o) => { if (o.isMesh) { vertsBefore += o.geometry.attributes.position.count; trisBefore += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });

  container.innerHTML = `
    <p class="hint">Before: ${vertsBefore} vertices, ${Math.round(trisBefore)} triangles.</p>
    <div class="checkbox-row"><input type="checkbox" id="mr-weld" checked><label for="mr-weld">Weld duplicate vertices</label></div>
    <div class="field" id="mr-tol-field">
      <label>Weld tolerance <span class="val" id="mr-tol-val">0.0010</span></label>
      <input type="range" id="mr-tol" min="0.0001" max="0.01" step="0.0001" value="0.001">
    </div>
    <div class="checkbox-row"><input type="checkbox" id="mr-degen" checked><label for="mr-degen">Remove degenerate (zero-area) triangles</label></div>
    <div class="checkbox-row"><input type="checkbox" id="mr-holes" checked><label for="mr-holes">Fill small boundary holes</label></div>
    <div class="checkbox-row"><input type="checkbox" id="mr-normals" checked><label for="mr-normals">Recompute normals</label></div>
    <button type="button" class="btn btn-primary" id="mr-run">Repair</button>
    <div id="mr-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn" id="mr-apply" disabled>Apply</button>
    </div>
  `;

  const tolSlider = container.querySelector('#mr-tol');
  container.querySelector('#mr-tol').addEventListener('input', () => container.querySelector('#mr-tol-val').textContent = Number(tolSlider.value).toFixed(4));

  const runBtn = container.querySelector('#mr-run');
  const applyBtn = container.querySelector('#mr-apply');
  const statusEl = container.querySelector('#mr-status');
  let resultGroup = null;

  runBtn.onclick = () => {
    if (!ctx.model) return;
    const doWeld = container.querySelector('#mr-weld').checked;
    const doDegen = container.querySelector('#mr-degen').checked;
    const doHoles = container.querySelector('#mr-holes').checked;
    const doNormals = container.querySelector('#mr-normals').checked;
    const tolerance = Number(tolSlider.value);

    let vertsAfter = 0, trisAfter = 0, totalHolesFilled = 0, totalDegenRemoved = 0;

    ctx.model.traverse((obj) => {
      if (!obj.isMesh) return;
      let geo = obj.geometry;
      if (doWeld) geo = mergeVertices(geo, tolerance);
      if (doDegen) {
        const r = removeDegenerateTriangles(geo);
        geo = r.geometry;
        totalDegenRemoved += r.removed;
      }
      if (doHoles) {
        const r = fillHoles(geo);
        geo = r.geometry;
        totalHolesFilled += r.holesFilled;
      }
      if (doNormals) geo.computeVertexNormals();
      obj.geometry = geo;
      vertsAfter += geo.attributes.position.count;
      trisAfter += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    });

    resultGroup = ctx.model;
    ctx.preview(resultGroup, ctx.animations);
    statusEl.textContent = `After: ${vertsAfter} vertices, ${Math.round(trisAfter)} triangles. Removed ${totalDegenRemoved} degenerate triangle(s), filled ${totalHolesFilled} hole(s).`;
    applyBtn.disabled = false;
  };

  applyBtn.onclick = () => {
    if (!resultGroup) return;
    apply(resultGroup, 'Mesh Repair');
  };
}
