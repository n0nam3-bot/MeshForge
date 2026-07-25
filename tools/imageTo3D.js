import * as THREE from 'three';

export const meta = {
  id: 'imageTo3D',
  name: 'Image → 3D',
  icon: '◱',
  section: 'start',
  description: 'Turn a flat image into a rounded, inflated 3D shape (like a sticker puffed into a solid).',
  requires: [],
};

/* ---------------------------------------------------------------------
   Core algorithm - validated separately (test_distance.mjs, test_inflate2.mjs)
   against: a hand-checked distance-transform grid, a solid-square shape and
   a concave L-shape, both confirmed fully watertight (0 boundary edges)
   with all rim triangles facing outward.
   --------------------------------------------------------------------- */
function distanceTransform(mask, width, height) {
  const dist = new Float32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  let qHead = 0, qTail = 0;
  for (let i = 0; i < width * height; i++) if (mask[i] === 0) { dist[i] = 0; queue[qTail++] = i; }
  const nbrs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width, y = (idx / width) | 0;
    for (const [dx, dy] of nbrs4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (dist[nIdx] === -1) { dist[nIdx] = dist[idx] + 1; queue[qTail++] = nIdx; }
    }
  }
  return dist;
}

function buildInflatedMesh({ mask, width, height, depthStrength }) {
  const dist = distanceTransform(mask, width, height);
  let maxDist = 1;
  for (let i = 0; i < dist.length; i++) if (mask[i] === 1) maxDist = Math.max(maxDist, dist[i]);
  const heightAt = (x, y) => depthStrength * Math.sqrt(Math.max(0, Math.min(1, dist[y * width + x] / maxDist)));

  const isFg = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  const wx = (x) => x - width / 2 + 0.5;
  const wy = (y) => (height / 2 - y) - 0.5;

  const frontIdx = new Int32Array(width * height).fill(-1);
  const backIdx = new Int32Array(width * height).fill(-1);
  const positions = [], uvs = [];
  function pushVertex(x, y, z, u, v) { positions.push(x, y, z); uvs.push(u, v); return positions.length / 3 - 1; }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFg(x, y)) continue;
      const h = heightAt(x, y);
      const u = x / Math.max(1, width - 1), v = 1 - y / Math.max(1, height - 1);
      frontIdx[y * width + x] = pushVertex(wx(x), wy(y), h, u, v);
      backIdx[y * width + x] = pushVertex(wx(x), wy(y), -h, u, v);
    }
  }

  const indices = [];
  const cellExists = (x, y) => isFg(x, y) && isFg(x + 1, y) && isFg(x, y + 1) && isFg(x + 1, y + 1);
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      if (!cellExists(x, y)) continue;
      const a = frontIdx[y * width + x], b = frontIdx[y * width + (x + 1)];
      const c = frontIdx[(y + 1) * width + x], d = frontIdx[(y + 1) * width + (x + 1)];
      indices.push(a, c, d, a, d, b); // front, +z outward (verified winding)
      const A = backIdx[y * width + x], B = backIdx[y * width + (x + 1)];
      const C = backIdx[(y + 1) * width + x], D = backIdx[(y + 1) * width + (x + 1)];
      indices.push(A, D, C, A, B, D); // back, -z outward
    }
  }

  // rim: directed-edge cancellation over the 2D cell grid finds silhouette
  // boundary edges; verified winding closes them into outward-facing walls
  const gp = (x, y) => y * width + x;
  const directed = new Map();
  const key = (a, b) => `${a}>${b}`;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      if (!cellExists(x, y)) continue;
      const tl = gp(x, y), tr = gp(x + 1, y), br = gp(x + 1, y + 1), bl = gp(x, y + 1);
      for (const [p, q] of [[tl, tr], [tr, br], [br, bl], [bl, tl]]) {
        directed.set(key(p, q), (directed.get(key(p, q)) || 0) + 1);
      }
    }
  }
  for (const [k] of directed) {
    const [a, b] = k.split('>').map(Number);
    if (directed.has(key(b, a))) continue;
    const ax = a % width, ay = (a / width) | 0, bx = b % width, by = (b / width) | 0;
    const fA = frontIdx[gp(ax, ay)], fB = frontIdx[gp(bx, by)];
    const bA = backIdx[gp(ax, ay)], bB = backIdx[gp(bx, by)];
    indices.push(fA, fB, bB, fA, bB, bA);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildMask(imageData, tolerance) {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { hasAlpha = true; break; }

  if (hasAlpha) {
    for (let i = 0, p = 0; i < data.length; i += 4, p++) mask[p] = data[i + 3] > 128 ? 1 : 0;
  } else {
    // chroma-key against the average of the 4 corner pixels
    const corners = [0, (width - 1) * 4, (height - 1) * width * 4, ((height - 1) * width + width - 1) * 4];
    let r = 0, g = 0, b = 0;
    for (const c of corners) { r += data[c]; g += data[c + 1]; b += data[c + 2]; }
    r /= 4; g /= 4; b /= 4;
    const thresh = tolerance * 260;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const dr = data[i] - r, dg = data[i + 1] - g, db = data[i + 2] - b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      mask[p] = dist > thresh ? 1 : 0;
    }
  }
  return mask;
}

/* ---------------------------------------------------------------------
   UI
   --------------------------------------------------------------------- */
export function buildPanel(container, ctx, apply) {
  container.innerHTML = `
    <p class="hint">Works best with a clear subject on a plain or transparent background - like a logo, sticker, or a photo with the background removed.</p>
    <button type="button" class="btn btn-primary" id="i23-choose">Choose image</button>
    <img id="i23-preview" style="display:none;max-width:100%;border-radius:8px;margin-top:10px;border:1px solid var(--line);" />

    <div class="field" style="margin-top:16px;">
      <label>Detail (grid resolution) <span class="val" id="i23-res-val">112</span></label>
      <input type="range" id="i23-res" min="48" max="176" step="8" value="112">
    </div>
    <div class="field">
      <label>Puffiness (depth) <span class="val" id="i23-depth-val">0.50</span></label>
      <input type="range" id="i23-depth" min="0.1" max="1.2" step="0.05" value="0.5">
    </div>
    <div class="field" id="i23-tolerance-field">
      <label>Background tolerance <span class="val" id="i23-tol-val">0.35</span></label>
      <input type="range" id="i23-tol" min="0.05" max="0.8" step="0.05" value="0.35">
      <div class="hint" style="margin:4px 0 0;">Only used for flat-color backgrounds (no transparency detected). Higher = removes more.</div>
    </div>

    <button type="button" class="btn" id="i23-generate" disabled>Generate</button>
    <div id="i23-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn" id="i23-apply" disabled>Use this model</button>
    </div>
  `;

  const chooseBtn = container.querySelector('#i23-choose');
  const previewImg = container.querySelector('#i23-preview');
  const resSlider = container.querySelector('#i23-res');
  const depthSlider = container.querySelector('#i23-depth');
  const tolSlider = container.querySelector('#i23-tol');
  const generateBtn = container.querySelector('#i23-generate');
  const applyBtn = container.querySelector('#i23-apply');
  const statusEl = container.querySelector('#i23-status');
  const input = document.getElementById('file-input-image');

  container.querySelector('#i23-res').addEventListener('input', (e) => container.querySelector('#i23-res-val').textContent = e.target.value);
  container.querySelector('#i23-depth').addEventListener('input', (e) => container.querySelector('#i23-depth-val').textContent = Number(e.target.value).toFixed(2));
  container.querySelector('#i23-tol').addEventListener('input', (e) => container.querySelector('#i23-tol-val').textContent = Number(e.target.value).toFixed(2));

  let sourceBitmap = null;
  let pendingGroup = null;

  chooseBtn.onclick = () => { input.value = ''; input.click(); };

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      sourceBitmap = await createImageBitmap(file);
      previewImg.src = URL.createObjectURL(file);
      previewImg.style.display = 'block';
      generateBtn.disabled = false;
      statusEl.textContent = 'Image loaded — adjust sliders if you like, then tap Generate.';
    } catch (err) {
      statusEl.textContent = 'Could not read that image: ' + (err?.message || err);
    }
  };

  generateBtn.onclick = () => {
    if (!sourceBitmap) return;
    statusEl.textContent = 'Generating…';
    applyBtn.disabled = true;
    // brief timeout lets the status text paint before the synchronous work below
    setTimeout(() => {
      try {
        const resolution = Number(resSlider.value);
        const depthStrength = Number(depthSlider.value);
        const tolerance = Number(tolSlider.value);

        const aspect = sourceBitmap.width / sourceBitmap.height;
        const w = aspect >= 1 ? resolution : Math.max(8, Math.round(resolution * aspect));
        const h = aspect >= 1 ? Math.max(8, Math.round(resolution / aspect)) : resolution;

        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const c2d = canvas.getContext('2d', { willReadFrequently: true });
        c2d.clearRect(0, 0, w, h);
        c2d.drawImage(sourceBitmap, 0, 0, w, h);
        const imageData = c2d.getImageData(0, 0, w, h);

        const mask = buildMask(imageData, tolerance);
        let fgCount = 0;
        for (let i = 0; i < mask.length; i++) fgCount += mask[i];
        if (fgCount < 9) {
          statusEl.textContent = 'Almost nothing was detected as foreground — try raising the background tolerance, or use an image with a clearer subject.';
          return;
        }

        const geometry = buildInflatedMesh({ mask, width: w, height: h, depthStrength });
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometry, material);

        const group = new THREE.Group();
        group.add(mesh);
        // normalize overall size to roughly fit a 2-unit box regardless of resolution/aspect
        const box = new THREE.Box3().setFromObject(group);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        group.scale.setScalar(2 / maxDim);

        pendingGroup = group;
        ctx.preview(group, []);
        applyBtn.disabled = false;
        statusEl.textContent = `Generated (${fgCount} foreground cells). Tap Generate again to try different settings, or Use this model to continue.`;
      } catch (err) {
        statusEl.textContent = 'Generation failed: ' + (err?.message || err);
        ctx.showToast('Image → 3D failed - see details in the panel', true);
      }
    }, 30);
  };

  applyBtn.onclick = () => {
    if (!pendingGroup) return;
    apply(pendingGroup, 'Image → 3D', []);
  };
}
