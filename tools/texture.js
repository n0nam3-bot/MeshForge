import * as THREE from 'three';
import { boxProjectUV } from './uvUnwrap.js';

export const meta = {
  id: 'texture',
  name: 'Texture',
  icon: '◫',
  section: 'tools',
  description: 'Paint directly on the model in the viewport - colors, patterns, simple detail.',
  requires: ['hasGeometry'],
  requiresLabel: 'Needs a model first',
};

const PRESET_COLORS = ['#e8edf4', '#e2645a', '#f2a65a', '#f2e35a', '#5ad186', '#4fd1c5', '#5a8ff2', '#a05af2', '#1a1f2a'];

function ensureCanvasForMesh(mesh, canvasSize = 1024) {
  const existing = mesh.material?.map?.image;
  if (existing instanceof HTMLCanvasElement) return existing; // already has an independent paint canvas (see cloneModel in app.js)
  const canvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  const c2d = canvas.getContext('2d');
  if (existing && existing.width) {
    c2d.drawImage(existing, 0, 0, canvasSize, canvasSize);
  } else {
    c2d.fillStyle = mesh.material?.color ? `#${mesh.material.color.getHexString()}` : '#c9d4e0';
    c2d.fillRect(0, 0, canvasSize, canvasSize);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  mesh.material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6, metalness: 0.05 });
  return canvas;
}

export function buildPanel(container, ctx, apply) {
  container.innerHTML = `
    <p class="hint">Drag directly on the model in the viewport above to paint. Pinch/rotate is disabled while this panel is open.</p>
    <div class="color-row" id="tx-colors"></div>
    <div class="field">
      <label>Brush size <span class="val" id="tx-size-val">40</span></label>
      <input type="range" id="tx-size" min="4" max="160" step="2" value="40">
    </div>
    <div class="checkbox-row"><input type="checkbox" id="tx-eraser"><label for="tx-eraser">Eraser (reveal base color)</label></div>
    <div class="btn-row">
      <button type="button" class="btn" id="tx-fill">Fill flat color</button>
      <button type="button" class="btn btn-secondary" id="tx-clear">Clear to white</button>
    </div>
    <div id="tx-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="tx-apply">Apply</button>
    </div>
  `;

  if (!ctx.capabilities.hasUV) {
    ctx.model.traverse((o) => { if (o.isMesh) o.geometry = boxProjectUV(o.geometry, 1); });
    container.querySelector('#tx-status').textContent = 'No UVs were found, so a quick automatic UV was generated first.';
  }

  ctx.model.traverse((o) => { if (o.isMesh) ensureCanvasForMesh(o); });
  ctx.preview(ctx.model, ctx.animations);

  const colorRow = container.querySelector('#tx-colors');
  let currentColor = PRESET_COLORS[1];
  PRESET_COLORS.forEach((hex, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch-btn' + (i === 1 ? ' active' : '');
    btn.style.background = hex;
    btn.addEventListener('click', () => {
      currentColor = hex;
      colorRow.querySelectorAll('.color-swatch-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
    colorRow.appendChild(btn);
  });

  const sizeSlider = container.querySelector('#tx-size');
  sizeSlider.addEventListener('input', () => container.querySelector('#tx-size-val').textContent = sizeSlider.value);
  const eraserCheckbox = container.querySelector('#tx-eraser');
  const statusEl = container.querySelector('#tx-status');

  container.querySelector('#tx-fill').onclick = () => {
    ctx.model.traverse((o) => {
      if (!o.isMesh) return;
      const canvas = o.material?.map?.image;
      if (!canvas) return;
      const c2d = canvas.getContext('2d');
      c2d.fillStyle = currentColor;
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      o.material.map.needsUpdate = true;
    });
    statusEl.textContent = 'Filled all parts with the selected color.';
  };
  container.querySelector('#tx-clear').onclick = () => {
    ctx.model.traverse((o) => {
      if (!o.isMesh) return;
      const canvas = o.material?.map?.image;
      if (!canvas) return;
      const c2d = canvas.getContext('2d');
      c2d.fillStyle = '#ffffff';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      o.material.map.needsUpdate = true;
    });
    statusEl.textContent = 'Cleared to white.';
  };

  // --- painting via raycasting into the shared viewport ---
  const { camera, renderer, controls } = ctx.viewport;
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();
  let painting = false;
  const canvasEl = renderer.domElement;

  function paintAt(clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointerNDC, camera);
    const meshes = [];
    ctx.model.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0 || !hits[0].uv) return;
    const hit = hits[0];
    const mesh = hit.object;
    const canvas = mesh.material?.map?.image;
    if (!canvas) return;
    const u = hit.uv.x, v = 1 - hit.uv.y;
    const px = ((u % 1) + 1) % 1 * canvas.width;
    const py = ((v % 1) + 1) % 1 * canvas.height;
    const c2d = canvas.getContext('2d');
    const size = Number(sizeSlider.value);
    if (eraserCheckbox.checked) {
      const base = mesh.material?.color ? `#${mesh.material.color.getHexString()}` : '#ffffff';
      c2d.fillStyle = base;
    } else {
      c2d.fillStyle = currentColor;
    }
    c2d.beginPath();
    c2d.arc(px, py, size / 2, 0, Math.PI * 2);
    c2d.fill();
    mesh.material.map.needsUpdate = true;
  }

  function onPointerDown(e) {
    painting = true;
    paintAt(e.clientX, e.clientY);
  }
  function onPointerMove(e) {
    if (!painting) return;
    paintAt(e.clientX, e.clientY);
  }
  function onPointerUp() {
    painting = false;
  }

  // Disabled for the WHOLE panel session, not just reactively inside
  // onPointerDown - OrbitControls' own pointerdown listener was registered
  // back in app.js, before this panel ever opened, so it always runs before
  // this file's handler could react to a fresh pointerdown and would have
  // already started tracking a rotation drag by the time `enabled` flips.
  controls.enabled = false;
  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  // clean up viewport listeners + restore camera controls whichever way this panel closes
  const cleanup = () => {
    canvasEl.removeEventListener('pointerdown', onPointerDown);
    canvasEl.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    controls.enabled = true;
  };
  const closeBtn = document.getElementById('sheet-close');
  const backdrop = document.getElementById('sheet-backdrop');
  closeBtn.addEventListener('click', cleanup, { once: true });
  backdrop.addEventListener('click', cleanup, { once: true });

  container.querySelector('#tx-apply').onclick = () => {
    cleanup();
    apply(ctx.model, 'Texture');
  };
}
