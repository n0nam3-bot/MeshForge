import * as THREE from 'three';
import { removeDegenerateTriangles } from './meshRepair.js';

export const meta = {
  id: 'slice',
  name: 'Slice / Defrag',
  icon: '⛶',
  section: 'tools',
  description: 'Split a merged mesh into its separate parts, or cut it apart with a plane.',
  requires: ['hasGeometry'],
  requiresLabel: 'Needs a model first',
};

const PART_COLORS = [0xe2645a, 0xf2a65a, 0xf2e35a, 0x5ad186, 0x4fd1c5, 0x5a8ff2, 0xa05af2, 0xe85ac0];

/* Validated in test_components.mjs (two-box test + cylinder seam regression):
   position-keyed (not index-keyed) edge adjacency, with integer-rounding to
   avoid the toFixed sign-on-near-zero bug, and compact per-part vertex
   buffers so bounding boxes and exported file size are correct. */
const PRECISION = 10000;
function posKeyOf3(x, y, z) { return `${Math.round(x * PRECISION)}_${Math.round(y * PRECISION)}_${Math.round(z * PRECISION)}`; }

function splitByConnectedComponents(geometry) {
  const indexed = geometry.index ? geometry : geometry.toNonIndexed();
  if (!indexed.index) return [geometry];
  const pos = indexed.attributes.position;
  const norm = indexed.attributes.normal;
  const uv = indexed.attributes.uv;
  const index = indexed.index.array;
  const triCount = index.length / 3;

  const posKeyOf = new Array(pos.count);
  const canonicalId = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = posKeyOf3(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (!canonicalId.has(k)) canonicalId.set(k, canonicalId.size);
    posKeyOf[i] = canonicalId.get(k);
  }

  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }

  const edgeMap = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = posKeyOf[index[t * 3]], b = posKeyOf[index[t * 3 + 1]], c = posKeyOf[index[t * 3 + 2]];
    for (const [v1, v2] of [[a, b], [b, c], [c, a]]) {
      const key = v1 < v2 ? `${v1}_${v2}` : `${v2}_${v1}`;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(t);
    }
  }
  for (const tris of edgeMap.values()) for (let i = 1; i < tris.length; i++) union(tris[0], tris[i]);

  const groups = new Map();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }

  const results = [];
  for (const tris of groups.values()) {
    const remap = new Map();
    const triList = [];
    for (const t of tris) triList.push(index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
    for (const orig of triList) if (!remap.has(orig)) remap.set(orig, remap.size);
    const copyAttr = (attr, itemSize) => {
      const out = new Float32Array(remap.size * itemSize);
      for (const [origIdx, compactIdx] of remap) for (let k = 0; k < itemSize; k++) out[compactIdx * itemSize + k] = attr.array[origIdx * itemSize + k];
      return new THREE.Float32BufferAttribute(out, itemSize);
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', copyAttr(pos, 3));
    if (norm) g.setAttribute('normal', copyAttr(norm, 3));
    if (uv) g.setAttribute('uv', copyAttr(uv, 2));
    g.setIndex(triList.map((orig) => remap.get(orig)));
    g.computeVertexNormals();
    g.computeBoundingBox();
    results.push(g);
  }
  return results;
}

/* Validated in test_slice.mjs (subdivided cube through the middle): correct
   bounds, no NaNs, all clipped points land exactly on the cutting plane. */
function lerp(a, b, t) { return a + (b - a) * t; }
function interpVertex(vA, vB, t) {
  return {
    p: new THREE.Vector3().lerpVectors(vA.p, vB.p, t),
    n: new THREE.Vector3().lerpVectors(vA.n, vB.n, t).normalize(),
    uv: [lerp(vA.uv[0], vB.uv[0], t), lerp(vA.uv[1], vB.uv[1], t)],
  };
}
function sliceGeometryByPlane(geometry, plane) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.attributes.position, norm = geo.attributes.normal, uvAttr = geo.attributes.uv;
  const triCount = pos.count / 3;
  const frontVerts = [], backVerts = [];

  for (let t = 0; t < triCount; t++) {
    const tri = [];
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      const n = norm ? new THREE.Vector3().fromBufferAttribute(norm, i) : new THREE.Vector3(0, 1, 0);
      const uv = uvAttr ? [uvAttr.getX(i), uvAttr.getY(i)] : [0, 0];
      tri.push({ p, n, uv, d: plane.distanceToPoint(p) });
    }
    const frontCount = tri.filter((v) => v.d >= 0).length;
    if (frontCount === 3) { frontVerts.push(...tri); continue; }
    if (frontCount === 0) { backVerts.push(...tri); continue; }
    const lone = frontCount === 1 ? tri.findIndex((v) => v.d >= 0) : tri.findIndex((v) => v.d < 0);
    const a = tri[lone], b = tri[(lone + 1) % 3], c = tri[(lone + 2) % 3];
    const ab = interpVertex(a, b, a.d / (a.d - b.d));
    const ac = interpVertex(a, c, a.d / (a.d - c.d));
    if (frontCount === 1) { frontVerts.push(a, ab, ac); backVerts.push(ab, b, c, ab, c, ac); }
    else { backVerts.push(a, ab, ac); frontVerts.push(ab, b, c, ab, c, ac); }
  }

  function toGeometry(verts) {
    if (verts.length === 0) return null;
    const positions = new Float32Array(verts.length * 3), normals = new Float32Array(verts.length * 3), uvs = new Float32Array(verts.length * 2);
    verts.forEach((v, i) => {
      positions[i * 3] = v.p.x; positions[i * 3 + 1] = v.p.y; positions[i * 3 + 2] = v.p.z;
      normals[i * 3] = v.n.x; normals[i * 3 + 1] = v.n.y; normals[i * 3 + 2] = v.n.z;
      uvs[i * 2] = v.uv[0]; uvs[i * 2 + 1] = v.uv[1];
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const { geometry: cleaned } = removeDegenerateTriangles(g);
    cleaned.computeBoundingBox();
    return cleaned;
  }
  return { front: toGeometry(frontVerts), back: toGeometry(backVerts) };
}

function collectMeshes(group) {
  const meshes = [];
  group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  return meshes;
}

function hadSkeleton(group) {
  let found = false;
  group.traverse((o) => { if (o.isSkinnedMesh) found = true; });
  return found;
}

export function buildPanel(container, ctx, apply) {
  const rigged = hadSkeleton(ctx.model);
  container.innerHTML = `
    ${rigged ? '<p class="hint" style="color:var(--amber);">This model has a skeleton - slicing converts the result back to plain (non-rigged) geometry, and any animation will be cleared.</p>' : ''}
    <div class="field">
      <label>Mode</label>
      <select id="sl-mode">
        <option value="split">Auto-split into parts (defrag)</option>
        <option value="cut">Cut with a plane</option>
      </select>
    </div>
    <div id="sl-split-controls">
      <p class="hint">Finds separate, disconnected pieces within the mesh and splits them into individual parts.</p>
      <button type="button" class="btn btn-primary" id="sl-detect">Detect Parts</button>
    </div>
    <div id="sl-cut-controls" style="display:none;">
      <div class="field">
        <label>Axis</label>
        <select id="sl-axis"><option value="x">X</option><option value="y" selected>Y</option><option value="z">Z</option></select>
      </div>
      <div class="field">
        <label>Position <span class="val" id="sl-pos-val">0.00</span></label>
        <input type="range" id="sl-pos" min="-1" max="1" step="0.01" value="0">
      </div>
      <button type="button" class="btn btn-primary" id="sl-cut">Cut</button>
    </div>
    <div id="sl-parts-preview"></div>
    <div id="sl-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn" id="sl-apply" disabled>Apply</button>
    </div>
  `;

  const modeSelect = container.querySelector('#sl-mode');
  const splitControls = container.querySelector('#sl-split-controls');
  const cutControls = container.querySelector('#sl-cut-controls');
  const partsPreview = container.querySelector('#sl-parts-preview');
  const statusEl = container.querySelector('#sl-status');
  const applyBtn = container.querySelector('#sl-apply');
  let resultGroup = null;

  modeSelect.addEventListener('change', () => {
    splitControls.style.display = modeSelect.value === 'split' ? 'block' : 'none';
    cutControls.style.display = modeSelect.value === 'cut' ? 'block' : 'none';
    partsPreview.innerHTML = '';
    statusEl.textContent = '';
    applyBtn.disabled = true;
  });

  const box = new THREE.Box3().setFromObject(ctx.model);
  const posSlider = container.querySelector('#sl-pos');
  const axisSelect = container.querySelector('#sl-axis');
  function updateSliderRange() {
    const axis = axisSelect.value;
    posSlider.min = box.min[axis].toFixed(3);
    posSlider.max = box.max[axis].toFixed(3);
    posSlider.value = ((box.min[axis] + box.max[axis]) / 2).toFixed(3);
    container.querySelector('#sl-pos-val').textContent = Number(posSlider.value).toFixed(2);
  }
  axisSelect.addEventListener('change', updateSliderRange);
  posSlider.addEventListener('input', () => container.querySelector('#sl-pos-val').textContent = Number(posSlider.value).toFixed(2));
  updateSliderRange();

  container.querySelector('#sl-detect').onclick = () => {
    const meshes = collectMeshes(ctx.model);
    const newGroup = new THREE.Group();
    let colorIdx = 0, totalParts = 0;
    for (const mesh of meshes) {
      const parts = splitByConnectedComponents(mesh.geometry);
      for (const geo of parts) {
        const mat = new THREE.MeshStandardMaterial({ color: PART_COLORS[colorIdx % PART_COLORS.length], roughness: 0.6 });
        const m = new THREE.Mesh(geo, mat);
        m.name = `part_${totalParts + 1}`;
        newGroup.add(m);
        colorIdx++; totalParts++;
      }
    }
    resultGroup = newGroup;
    ctx.preview(resultGroup, []);
    partsPreview.innerHTML = newGroup.children.map((m) =>
      `<span class="part-chip"><span class="swatch" style="background:#${m.material.color.getHexString()}"></span>${m.name} (${m.geometry.index.count / 3} tris)</span>`
    ).join('');
    statusEl.textContent = `Found ${totalParts} part${totalParts === 1 ? '' : 's'}. Colors are temporary, just to show the split - original materials aren't preserved by auto-split.`;
    applyBtn.disabled = totalParts === 0;
  };

  container.querySelector('#sl-cut').onclick = () => {
    const meshes = collectMeshes(ctx.model);
    const axis = axisSelect.value;
    const normalVec = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const plane = new THREE.Plane(normalVec, -Number(posSlider.value));
    const newGroup = new THREE.Group();
    let frontCount = 0, backCount = 0;
    for (const mesh of meshes) {
      const { front, back } = sliceGeometryByPlane(mesh.geometry, plane);
      if (front && front.attributes.position.count > 0) {
        const m = new THREE.Mesh(front, mesh.material);
        m.name = (mesh.name || 'part') + '_A';
        newGroup.add(m);
        frontCount++;
      }
      if (back && back.attributes.position.count > 0) {
        const m = new THREE.Mesh(back, mesh.material);
        m.name = (mesh.name || 'part') + '_B';
        newGroup.add(m);
        backCount++;
      }
    }
    resultGroup = newGroup;
    ctx.preview(resultGroup, []);
    partsPreview.innerHTML = newGroup.children.map((m) => `<span class="part-chip">${m.name} (${m.geometry.index.count / 3} tris)</span>`).join('');
    statusEl.textContent = `Cut into ${frontCount + backCount} piece(s).`;
    applyBtn.disabled = newGroup.children.length === 0;
  };

  applyBtn.onclick = () => {
    if (!resultGroup) return;
    apply(resultGroup, 'Slice / Defrag', []);
  };
}
