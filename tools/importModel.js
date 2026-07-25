import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

export const meta = {
  id: 'importModel',
  name: 'Upload 3D Model',
  icon: '⬆',
  section: 'start',
  description: 'Bring in an existing .glb, .gltf, or .obj file as your starting point.',
  requires: [],
};

function normalizeScale(group) {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0 && (maxDim > 6 || maxDim < 0.08)) {
    group.scale.setScalar(2 / maxDim);
  }
}

export function buildPanel(container, ctx, apply) {
  container.innerHTML = `
    <p class="hint">Loads a model file straight into the viewer as your starting point. glTF/GLB keeps existing materials, skeleton and animations; OBJ brings in geometry only.</p>
    <button type="button" class="btn btn-primary" id="im-choose">Choose file (.glb / .gltf / .obj)</button>
    <div id="im-status" class="hint" style="margin-top:10px;"></div>
    <div class="btn-row">
      <button type="button" class="btn" id="im-apply" disabled>Use this model</button>
    </div>
  `;

  const statusEl = container.querySelector('#im-status');
  const chooseBtn = container.querySelector('#im-choose');
  const applyBtn = container.querySelector('#im-apply');
  const input = document.getElementById('file-input-model');

  let pendingGroup = null;
  let pendingAnimations = [];
  let pendingName = '';

  chooseBtn.onclick = () => {
    input.value = '';
    input.click();
  };

  // assigning .onchange (rather than addEventListener) replaces any handler
  // left over from a previous time this panel was opened, so listeners never
  // pile up on this shared, persistent <input> element
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    statusEl.textContent = `Loading ${file.name}…`;
    applyBtn.disabled = true;
    try {
      const ext = file.name.split('.').pop().toLowerCase();
      let group, animations = [];

      if (ext === 'obj') {
        const text = await file.text();
        const obj = new OBJLoader().parse(text);
        group = new THREE.Group();
        group.add(obj);
        group.traverse((o) => {
          if (o.isMesh && !o.material?.map) {
            o.material = new THREE.MeshStandardMaterial({ color: 0x9fb3c8, roughness: 0.6, metalness: 0.05 });
          }
        });
      } else {
        const buffer = await file.arrayBuffer();
        const gltf = await new Promise((resolve, reject) =>
          new GLTFLoader().parse(buffer, '', resolve, reject)
        );
        group = new THREE.Group();
        group.add(gltf.scene);
        animations = gltf.animations || [];
      }

      normalizeScale(group);
      pendingGroup = group;
      pendingAnimations = animations;
      pendingName = file.name;
      statusEl.textContent = `Loaded ${file.name}${animations.length ? ` (${animations.length} animation clip${animations.length > 1 ? 's' : ''} found)` : ''} — tap "Use this model" below.`;
      ctx.preview(group, animations);
      applyBtn.disabled = false;
    } catch (err) {
      statusEl.textContent = 'Could not load that file: ' + (err?.message || err);
      ctx.showToast('Import failed - see details in the panel', true);
    }
  };

  applyBtn.onclick = () => {
    if (!pendingGroup) return;
    apply(pendingGroup, `Imported ${pendingName}`, pendingAnimations);
  };
}
