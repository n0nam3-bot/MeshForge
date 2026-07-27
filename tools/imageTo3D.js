import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const meta = {
  id: 'imageTo3D',
  name: 'Image → 3D',
  icon: '◱',
  section: 'start',
  description: 'AI-generated 3D from a photo (via a free Hugging Face model), or a quick local fallback.',
  requires: [],
};

/* =========================================================================
   AI GENERATION - tencent/Hunyuan3D-2, a real neural image-to-3D model that
   also generates a full texture (not just a plain-colored mesh), called live
   from the browser via Hugging Face's official @gradio/client library
   (loaded from a CDN, no install/build step - inference runs on Hugging
   Face's free-tier infrastructure, not your device or any server of yours).

   HONESTY NOTE: this integration depends on a live third-party service I
   could not fully exercise end-to-end from a sandboxed environment (no real
   browser, no access to huggingface.co from the tool that validated
   everything else in this app). I fetched the Space's actual published
   gradio_app.py source to get the endpoint name and parameter order below,
   which is the same research method that worked for confirming the Space is
   real and current - but it's still a best-informed match, not something I
   could click-test myself. If Hugging Face changes the Space's internals,
   this may need a small update.

   The one thing I DID get concretely from that source: generation_all is
   decorated `@spaces.GPU(duration=90)`, meaning Hugging Face's own
   infrastructure force-kills it past 90 seconds. HARD_TIMEOUT_MS below is
   built around that documented number, specifically to prevent the failure
   mode of a request hanging indefinitely with no way to tell it's dead -
   which is what happened before this fix, with no automatic timeout at all.
   ========================================================================= */
const SPACE_ID = 'tencent/Hunyuan3D-2';
const GPU_BUDGET_MS = 90 * 1000; // documented in the Space's own source
const HARD_TIMEOUT_MS = GPU_BUDGET_MS + 45 * 1000; // + buffer for queueing/network/export

async function generateWithAI(imageFile, { removeBackground }, onStatus) {
  onStatus('Loading Hugging Face client library…');
  const { Client } = await import('https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js');

  onStatus(`Connecting to ${SPACE_ID} on Hugging Face…`);
  const app = await Client.connect(SPACE_ID);

  onStatus('Generating textured 3D mesh (shape + texture, ~1-2 minutes)…');
  // Positional args match generation_all()'s exact parameter order in the
  // Space's source: caption, image, 4x multi-view images (unused here),
  // steps, guidance_scale, seed, octree_resolution, remove_background,
  // num_chunks, randomize_seed. Kept on the lower end of steps/chunks to
  // stay comfortably inside the 90s GPU budget above.
  const result = await app.predict('/generation_all', [
    null, imageFile, null, null, null, null,
    15, 5.0, 1234, 256, removeBackground, 8000, false,
  ]);

  const glbInfo = result.data?.[1]; // [white_mesh, textured_mesh, viewer_html, stats, seed] - index 1 is the textured GLB
  const glbUrl = glbInfo?.url || glbInfo?.path;
  if (!glbUrl) throw new Error('The model finished but no textured GLB file came back.');

  onStatus('Downloading result…');
  const res = await fetch(glbUrl);
  if (!res.ok) throw new Error(`Could not download the generated model (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

async function generateWithAITimed(imageFile, options, onStatus) {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`No response after ${Math.round(HARD_TIMEOUT_MS / 1000)}s - the Space may be overloaded, asleep, or its API may have changed since this was written.`));
    }, HARD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([generateWithAI(imageFile, options, onStatus), timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function loadGlbArrayBuffer(arrayBuffer) {
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', resolve, reject));
  const group = new THREE.Group();
  group.add(gltf.scene);
  return group;
}

/* =========================================================================
   LOCAL FALLBACK - distance-transform inflate, works fully offline. Validated
   in test_distance.mjs and test_inflate2.mjs (a solid square and a concave
   L-shape, both confirmed watertight with correctly outward-facing normals).
   Not a substitute for real 3D inference - see the honesty note above - but
   it always works, with no internet dependency and no rate limits.
   ========================================================================= */
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
      indices.push(a, c, d, a, d, b);
      const A = backIdx[y * width + x], B = backIdx[y * width + (x + 1)];
      const C = backIdx[(y + 1) * width + x], D = backIdx[(y + 1) * width + (x + 1)];
      indices.push(A, D, C, A, B, D);
    }
  }

  const gp = (x, y) => y * width + x;
  const directed = new Map();
  const key = (a, b) => `${a}>${b}`;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      if (!cellExists(x, y)) continue;
      const tl = gp(x, y), tr = gp(x + 1, y), br = gp(x + 1, y + 1), bl = gp(x, y + 1);
      for (const [p, q] of [[tl, tr], [tr, br], [br, bl], [bl, tl]]) directed.set(key(p, q), (directed.get(key(p, q)) || 0) + 1);
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
    const corners = [0, (width - 1) * 4, (height - 1) * width * 4, ((height - 1) * width + width - 1) * 4];
    let r = 0, g = 0, b = 0;
    for (const c of corners) { r += data[c]; g += data[c + 1]; b += data[c + 2]; }
    r /= 4; g /= 4; b /= 4;
    const thresh = tolerance * 260;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const dr = data[i] - r, dg = data[i + 1] - g, db = data[i + 2] - b;
      mask[p] = Math.sqrt(dr * dr + dg * dg + db * db) > thresh ? 1 : 0;
    }
  }
  return mask;
}

function normalizeScale(group) {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  group.scale.setScalar(2 / maxDim);
}

/* =========================================================================
   UI
   ========================================================================= */
export function buildPanel(container, ctx, apply) {
  container.innerHTML = `
    <p class="hint">Works best with a clear subject on a plain or transparent background - like a logo, sticker, or a product photo.</p>
    <button type="button" class="btn btn-primary" id="i23-choose">Choose image</button>
    <img id="i23-preview" style="display:none;max-width:100%;border-radius:8px;margin-top:10px;border:1px solid var(--line);" />

    <div class="checkbox-row" style="margin-top:16px;"><input type="checkbox" id="i23-removebg" checked><label for="i23-removebg">Remove background automatically</label></div>
    <button type="button" class="btn btn-primary" id="i23-ai-generate" disabled>Generate with AI (Hunyuan3D-2, via Hugging Face)</button>
    <div class="progress-track" id="i23-progress-track" style="display:none;"><div class="progress-fill-indeterminate"></div></div>
    <div id="i23-ai-status" class="hint"></div>
    <button type="button" class="btn btn-secondary" id="i23-ai-cancel" style="display:none;">Cancel</button>
    <p class="hint">Uses a free public Hugging Face model over the internet - needs a connection, and can be slow or briefly unavailable at busy times. If it doesn't work right now, use the offline option below instead.</p>

    <details style="margin-top:6px;">
      <summary style="cursor:pointer;color:var(--muted);font-size:12.5px;">Offline fallback (no internet needed, lower quality)</summary>
      <div style="padding-top:10px;">
        <div class="field">
          <label>Background tolerance <span class="val" id="i23-tol-val">0.35</span></label>
          <input type="range" id="i23-tol" min="0.05" max="0.8" step="0.05" value="0.35">
          <div class="hint" style="margin:4px 0 0;">Only matters for flat-color backgrounds (no transparency). Higher = removes more.</div>
        </div>
        <div class="field">
          <label>Detail (grid resolution) <span class="val" id="i23-res-val">112</span></label>
          <input type="range" id="i23-res" min="48" max="176" step="8" value="112">
        </div>
        <div class="field">
          <label>Puffiness (depth) <span class="val" id="i23-depth-val">0.50</span></label>
          <input type="range" id="i23-depth" min="0.1" max="1.2" step="0.05" value="0.5">
        </div>
        <button type="button" class="btn" id="i23-local-generate" disabled>Generate locally (offline)</button>
      </div>
    </details>

    <div id="i23-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn" id="i23-apply" disabled>Use this model</button>
    </div>
  `;

  const chooseBtn = container.querySelector('#i23-choose');
  const previewImg = container.querySelector('#i23-preview');
  const removeBgCheckbox = container.querySelector('#i23-removebg');
  const aiGenerateBtn = container.querySelector('#i23-ai-generate');
  const aiStatusEl = container.querySelector('#i23-ai-status');
  const progressTrack = container.querySelector('#i23-progress-track');
  const tolSlider = container.querySelector('#i23-tol');
  const resSlider = container.querySelector('#i23-res');
  const depthSlider = container.querySelector('#i23-depth');
  const localGenerateBtn = container.querySelector('#i23-local-generate');
  const statusEl = container.querySelector('#i23-status');
  const applyBtn = container.querySelector('#i23-apply');
  const input = document.getElementById('file-input-image');

  tolSlider.addEventListener('input', () => container.querySelector('#i23-tol-val').textContent = Number(tolSlider.value).toFixed(2));
  resSlider.addEventListener('input', () => container.querySelector('#i23-res-val').textContent = resSlider.value);
  depthSlider.addEventListener('input', () => container.querySelector('#i23-depth-val').textContent = Number(depthSlider.value).toFixed(2));

  let sourceFile = null;
  let sourceBitmap = null;
  let pendingGroup = null;

  chooseBtn.onclick = () => { input.value = ''; input.click(); };

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    sourceFile = file;
    try {
      sourceBitmap = await createImageBitmap(file);
      previewImg.src = URL.createObjectURL(file);
      previewImg.style.display = 'block';
      aiGenerateBtn.disabled = false;
      localGenerateBtn.disabled = false;
      aiStatusEl.textContent = '';
      statusEl.textContent = 'Image loaded.';
    } catch (err) {
      statusEl.textContent = 'Could not read that image: ' + (err?.message || err);
    }
  };

  const cancelBtn = container.querySelector('#i23-ai-cancel');

  aiGenerateBtn.onclick = async () => {
    if (!sourceFile) return;
    aiGenerateBtn.disabled = true;
    progressTrack.style.display = 'block';
    cancelBtn.style.display = 'block';

    let cancelled = false;
    cancelBtn.onclick = () => {
      cancelled = true;
      aiStatusEl.textContent = 'Cancelled. The request may still finish in the background, but its result will be ignored.';
      finishUp();
    };

    const startTime = Date.now();
    let baseMsg = 'Starting…';
    const setMsg = (msg) => { baseMsg = msg; };
    const timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      let text = `${baseMsg} (${elapsed}s elapsed)`;
      if (elapsed > 75) text += ' — generating both shape and texture can take a couple of minutes on the free tier; still working.';
      aiStatusEl.textContent = text;
    }, 1000);

    function finishUp() {
      clearInterval(timer);
      aiGenerateBtn.disabled = false;
      progressTrack.style.display = 'none';
      cancelBtn.style.display = 'none';
    }

    try {
      const arrayBuffer = await generateWithAITimed(
        sourceFile,
        { removeBackground: removeBgCheckbox.checked },
        setMsg
      );
      if (cancelled) return;
      const group = await loadGlbArrayBuffer(arrayBuffer);
      if (cancelled) return;
      normalizeScale(group);
      pendingGroup = group;
      ctx.preview(group, []);
      aiStatusEl.textContent = 'Done! Tap "Use this model" below to continue, or generate again with different settings.';
      applyBtn.disabled = false;
    } catch (err) {
      if (!cancelled) {
        aiStatusEl.textContent = `AI generation failed: ${err?.message || err}. You can try again, or use the offline fallback below.`;
        ctx.showToast('AI generation failed - see details in the panel', true);
      }
    } finally {
      if (!cancelled) finishUp();
    }
  };

  localGenerateBtn.onclick = () => {
    if (!sourceBitmap) return;
    statusEl.textContent = 'Generating locally…';
    setTimeout(() => {
      try {
        const resolution = Number(resSlider.value);
        const depthStrength = Number(depthSlider.value);
        const aspect = sourceBitmap.width / sourceBitmap.height;
        const w = aspect >= 1 ? resolution : Math.max(8, Math.round(resolution * aspect));
        const h = aspect >= 1 ? Math.max(8, Math.round(resolution / aspect)) : resolution;

        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const c2d = canvas.getContext('2d', { willReadFrequently: true });
        c2d.clearRect(0, 0, w, h);
        c2d.drawImage(sourceBitmap, 0, 0, w, h);
        const imageData = c2d.getImageData(0, 0, w, h);

        const mask = buildMask(imageData, Number(tolSlider.value));
        let fgCount = 0;
        for (let i = 0; i < mask.length; i++) fgCount += mask[i];
        if (fgCount < 9) {
          statusEl.textContent = 'Almost nothing was detected as foreground - try a different image, or uncheck "remove background" if this photo has no flat background to key out.';
          return;
        }

        const geometry = buildInflatedMesh({ mask, width: w, height: h, depthStrength });
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });
        const group = new THREE.Group();
        group.add(new THREE.Mesh(geometry, material));
        normalizeScale(group);

        pendingGroup = group;
        ctx.preview(group, []);
        applyBtn.disabled = false;
        statusEl.textContent = `Generated locally (${fgCount} foreground cells). This is a simple "inflate", not real 3D inference - expect a puffy-relief look, not true depth.`;
      } catch (err) {
        statusEl.textContent = 'Local generation failed: ' + (err?.message || err);
      }
    }, 30);
  };

  applyBtn.onclick = () => {
    if (!pendingGroup) return;
    apply(pendingGroup, 'Image → 3D', []);
  };
}
