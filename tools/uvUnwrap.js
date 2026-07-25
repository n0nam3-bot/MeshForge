import * as THREE from 'three';

export const meta = {
  id: 'uvUnwrap',
  name: 'UV Unwrap',
  icon: '▦',
  section: 'tools',
  description: '6-direction box projection - simple, works well on hard-surface shapes.',
  requires: ['hasGeometry'],
  requiresLabel: 'Needs a model first',
};

/* Validated separately in test_uv.mjs: box-projection picks the dominant
   world axis of each triangle's face normal and uses the other two axes as
   (u, v). Simple, seamless-ish on hard-surface shapes, can stretch on
   curved/organic ones - documented tradeoff for a from-scratch auto-UV. */
export function boxProjectUV(geometry, tileSize) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = geo.attributes.position;
  const triCount = pos.count / 3;
  const uvArray = new Float32Array(pos.count * 2);
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3, i1 = t * 3 + 1, i2 = t * 3 + 2;
    pA.fromBufferAttribute(pos, i0); pB.fromBufferAttribute(pos, i1); pC.fromBufferAttribute(pos, i2);
    e1.subVectors(pB, pA); e2.subVectors(pC, pA);
    n.crossVectors(e1, e2).normalize();
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let uAxis, vAxis;
    if (ax >= ay && ax >= az) { uAxis = 'y'; vAxis = 'z'; }
    else if (ay >= ax && ay >= az) { uAxis = 'x'; vAxis = 'z'; }
    else { uAxis = 'x'; vAxis = 'y'; }
    for (const i of [i0, i1, i2]) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      uvArray[i * 2] = v[uAxis] / tileSize;
      uvArray[i * 2 + 1] = v[vAxis] / tileSize;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
  return geo;
}

function drawUVPreview(canvas, uvSamples) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 300, h = 220;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  c.clearRect(0, 0, w, h);
  if (uvSamples.length === 0) return;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [u, v] of uvSamples) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
  const spanU = Math.max(maxU - minU, 1e-6), spanV = Math.max(maxV - minV, 1e-6);
  const pad = 12;
  const scale = Math.min((w - pad * 2) / spanU, (h - pad * 2) / spanV);
  const mapX = (u) => pad + (u - minU) * scale;
  const mapY = (v) => h - (pad + (v - minV) * scale);
  c.strokeStyle = '#2f6f68';
  c.lineWidth = 1;
  for (let i = 0; i < uvSamples.length; i += 3) {
    const [u0, v0] = uvSamples[i], [u1, v1] = uvSamples[i + 1], [u2, v2] = uvSamples[i + 2];
    c.beginPath();
    c.moveTo(mapX(u0), mapY(v0));
    c.lineTo(mapX(u1), mapY(v1));
    c.lineTo(mapX(u2), mapY(v2));
    c.closePath();
    c.stroke();
  }
}

export function buildPanel(container, ctx, apply) {
  const hadUV = ctx.capabilities.hasUV;
  container.innerHTML = `
    <p class="hint">${hadUV ? 'This model already has UVs - regenerating will replace them.' : 'This model has no UVs yet.'} Box projection assigns coordinates using the 3 world axes, tiled at a fixed world-space scale (so texture detail stays consistent regardless of model size).</p>
    <div class="field">
      <label>Tile size (world units per texture repeat) <span class="val" id="uv-tile-val">1.00</span></label>
      <input type="range" id="uv-tile" min="0.1" max="4" step="0.05" value="1">
    </div>
    <button type="button" class="btn btn-primary" id="uv-generate">Generate UVs</button>
    <div id="uv-status" class="hint"></div>
    <canvas class="uv-preview" id="uv-preview" style="display:none;"></canvas>
    <div class="btn-row">
      <button type="button" class="btn" id="uv-apply" disabled>Apply</button>
    </div>
  `;

  const tileSlider = container.querySelector('#uv-tile');
  const tileVal = container.querySelector('#uv-tile-val');
  const generateBtn = container.querySelector('#uv-generate');
  const applyBtn = container.querySelector('#uv-apply');
  const statusEl = container.querySelector('#uv-status');
  const previewCanvas = container.querySelector('#uv-preview');

  tileSlider.addEventListener('input', () => tileVal.textContent = Number(tileSlider.value).toFixed(2));

  let resultGroup = null;

  generateBtn.onclick = () => {
    if (!ctx.model) return;
    const tileSize = Number(tileSlider.value);
    const uvSamples = [];
    let meshCount = 0;

    ctx.model.traverse((obj) => {
      if (obj.isMesh) {
        meshCount++;
        obj.geometry = boxProjectUV(obj.geometry, tileSize);
        const uvAttr = obj.geometry.attributes.uv;
        // sample up to ~600 triangles across the whole model for the preview
        const triCount = uvAttr.count / 3;
        const step = Math.max(1, Math.floor(triCount / 200));
        for (let t = 0; t < triCount; t += step) {
          uvSamples.push(
            [uvAttr.getX(t * 3), uvAttr.getY(t * 3)],
            [uvAttr.getX(t * 3 + 1), uvAttr.getY(t * 3 + 1)],
            [uvAttr.getX(t * 3 + 2), uvAttr.getY(t * 3 + 2)]
          );
        }
      }
    });

    resultGroup = ctx.model;
    ctx.preview(resultGroup, ctx.animations);
    previewCanvas.style.display = 'block';
    drawUVPreview(previewCanvas, uvSamples);
    statusEl.textContent = `UVs generated for ${meshCount} mesh part${meshCount === 1 ? '' : 's'}.`;
    applyBtn.disabled = false;
  };

  applyBtn.onclick = () => {
    if (!resultGroup) return;
    apply(resultGroup, 'UV Unwrap');
  };
}
