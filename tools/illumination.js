import * as THREE from 'three';

export const meta = {
  id: 'illumination',
  name: 'Illumination',
  icon: '☼',
  section: 'tools',
  description: 'Bakes soft ambient-occlusion shading into the mesh so creases and dents read correctly under any lighting.',
  requires: ['hasGeometry'],
  requiresLabel: 'Needs a model first',
};

const PRECISION = 10000;
function posKey(x, y, z) { return `${Math.round(x * PRECISION)}_${Math.round(y * PRECISION)}_${Math.round(z * PRECISION)}`; }

// Curvature/cavity approximation, validated in test_cavity.mjs: a vertex
// pulled inward relative to its neighbor average (a dent/crease) darkens;
// convex areas stay bright. Deliberately avoids per-vertex raycasting - a
// "real" AO bake needs a spatial acceleration structure (e.g. a BVH) to run
// fast enough on a phone without one; this cavity approach is O(vertices)
// and needs no extra dependency, at the cost of being an approximation
// rather than true occlusion.
function computeCavityAO(geometry, intensity) {
  const geo = geometry;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const index = geo.index ? geo.index.array : null;
  const triCount = index ? index.length / 3 : pos.count / 3;

  const canonicalId = new Map();
  const posKeyOf = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = posKey(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (!canonicalId.has(k)) canonicalId.set(k, canonicalId.size);
    posKeyOf[i] = canonicalId.get(k);
  }
  const neighborsOf = new Map();
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index[t * 3] : t * 3, i1 = index ? index[t * 3 + 1] : t * 3 + 1, i2 = index ? index[t * 3 + 2] : t * 3 + 2;
    const a = posKeyOf[i0], b = posKeyOf[i1], c = posKeyOf[i2];
    for (const [p, q] of [[a, b], [b, c], [c, a], [b, a], [c, b], [a, c]]) {
      if (!neighborsOf.has(p)) neighborsOf.set(p, new Set());
      neighborsOf.get(p).add(q);
    }
  }
  const representative = new Map();
  for (let i = 0; i < pos.count; i++) if (!representative.has(posKeyOf[i])) representative.set(posKeyOf[i], i);

  const rawConcavity = new Map();
  for (const [cid, neighborSet] of neighborsOf) {
    const repIdx = representative.get(cid);
    const p = new THREE.Vector3().fromBufferAttribute(pos, repIdx);
    const n = new THREE.Vector3().fromBufferAttribute(norm, repIdx);
    const avg = new THREE.Vector3();
    for (const nb of neighborSet) avg.add(new THREE.Vector3().fromBufferAttribute(pos, representative.get(nb)));
    avg.multiplyScalar(1 / neighborSet.size);
    const delta = new THREE.Vector3().subVectors(avg, p);
    rawConcavity.set(cid, delta.dot(n));
  }

  let maxAbs = 1e-6;
  for (const v of rawConcavity.values()) maxAbs = Math.max(maxAbs, Math.abs(v));

  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const cid = posKeyOf[i];
    const raw = rawConcavity.get(cid) || 0;
    const normalized = Math.max(-1, Math.min(1, raw / maxAbs));
    const ao = 1 - Math.max(0, normalized) * intensity;
    colors[i * 3] = ao; colors[i * 3 + 1] = ao; colors[i * 3 + 2] = ao;
  }
  return colors;
}

export function buildPanel(container, ctx, apply) {
  container.innerHTML = `
    <p class="hint">Adds a subtle shadow into creases and dents, baked directly into the mesh's vertex colors - it'll show up in any engine, under any lighting.</p>
    <div class="field">
      <label>Strength <span class="val" id="il-strength-val">0.65</span></label>
      <input type="range" id="il-strength" min="0" max="1" step="0.05" value="0.65">
    </div>
    <button type="button" class="btn btn-primary" id="il-bake">Bake</button>
    <div id="il-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn" id="il-apply" disabled>Apply</button>
    </div>
  `;

  const strengthSlider = container.querySelector('#il-strength');
  container.querySelector('#il-strength').addEventListener('input', () => container.querySelector('#il-strength-val').textContent = Number(strengthSlider.value).toFixed(2));
  const bakeBtn = container.querySelector('#il-bake');
  const applyBtn = container.querySelector('#il-apply');
  const statusEl = container.querySelector('#il-status');
  let resultGroup = null;

  bakeBtn.onclick = () => {
    if (!ctx.model) return;
    statusEl.textContent = 'Baking…';
    setTimeout(() => {
      const intensity = Number(strengthSlider.value);
      let meshCount = 0;
      ctx.model.traverse((obj) => {
        if (!obj.isMesh) return;
        meshCount++;
        const colors = computeCavityAO(obj.geometry, intensity);
        obj.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        if (obj.material) {
          obj.material.vertexColors = true;
          obj.material.needsUpdate = true;
        }
      });
      resultGroup = ctx.model;
      ctx.preview(resultGroup, ctx.animations);
      statusEl.textContent = `Baked AO onto ${meshCount} mesh part${meshCount === 1 ? '' : 's'}.`;
      applyBtn.disabled = false;
    }, 20);
  };

  applyBtn.onclick = () => {
    if (!resultGroup) return;
    apply(resultGroup, 'Illumination');
  };
}
