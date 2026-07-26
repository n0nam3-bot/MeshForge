import * as THREE from 'three';
import { createBoneInteraction } from './_boneDrag.js';

export const meta = {
  id: 'jiggle',
  name: 'Jiggle',
  icon: '〜',
  section: 'tools',
  description: 'Adds secondary spring-bone motion (hair, tails, ears, bellies) to selected bones.',
  requires: ['hasSkeleton'],
  requiresLabel: 'Needs bones/joints first',
};

const SUGGESTED_JIGGLE_NAMES = new Set(['Head', 'HeadTop', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Tip']);

/* ---------------------------------------------------------------------
   Physics - runs every frame from app.js's render loop (only while a model
   with userData.jiggleEnabled is on screen). Applies the spring's frame-to-
   frame CHANGE as an incremental quaternion multiply rather than tracking an
   absolute "base pose" - this composes correctly whether or not an
   AnimationMixer is also driving the same bone that frame, since it never
   needs to know or overwrite whatever pose was already there.
   All persistent state is plain numbers in userData (not Vector3/Quaternion
   instances) since userData is JSON-round-tripped on every clone (see
   app.js's cloneModel) - a class instance stored there would silently turn
   into a dead plain object the next time a tool panel is opened.
   --------------------------------------------------------------------- */
function stepJiggleBone(bone, dt, config) {
  const ud = bone.userData;
  if (!ud._jiggleVel) ud._jiggleVel = { x: 0, z: 0 };
  if (!ud._jiggleOffset) ud._jiggleOffset = { x: 0, z: 0 };

  const worldPos = new THREE.Vector3();
  bone.getWorldPosition(worldPos);
  if (!ud._jigglePrevWorldPos) ud._jigglePrevWorldPos = { x: worldPos.x, y: worldPos.y, z: worldPos.z };
  const prev = ud._jigglePrevWorldPos;
  const safeDt = Math.max(dt, 1 / 240);
  const velX = (worldPos.x - prev.x) / safeDt;
  const velZ = (worldPos.z - prev.z) / safeDt;
  ud._jigglePrevWorldPos = { x: worldPos.x, y: worldPos.y, z: worldPos.z };

  const excitationX = -velZ * config.amount;
  const excitationZ = velX * config.amount;

  const ov = ud._jiggleVel, oo = ud._jiggleOffset;
  ov.x += (-config.stiffness * oo.x - config.damping * ov.x + excitationX) * dt;
  ov.z += (-config.stiffness * oo.z - config.damping * ov.z + excitationZ) * dt;

  const newX = Math.max(-0.9, Math.min(0.9, oo.x + ov.x * dt));
  const newZ = Math.max(-0.9, Math.min(0.9, oo.z + ov.z * dt));
  const deltaX = newX - oo.x, deltaZ = newZ - oo.z;
  oo.x = newX; oo.z = newZ;

  if (Math.abs(deltaX) > 1e-6 || Math.abs(deltaZ) > 1e-6) {
    bone.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(deltaX, 0, deltaZ)));
  }
}

export function updateJiggle(group, dt) {
  if (!group?.userData?.jiggleEnabled) return;
  const configs = group.userData.jiggleBones;
  if (!configs || configs.length === 0) return;
  let skeleton = null;
  group.traverse((o) => { if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton; });
  if (!skeleton) return;
  for (const cfg of configs) {
    const bone = skeleton.bones.find((b) => b.name === cfg.boneName);
    if (bone) stepJiggleBone(bone, dt, cfg);
  }
}

/* ---------------------------------------------------------------------
   UI
   --------------------------------------------------------------------- */
export function buildPanel(container, ctx, apply) {
  let skeleton = null;
  ctx.model.traverse((o) => { if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton; });

  container.innerHTML = `
    <p class="hint">Pick which bones should jiggle. Extremities (hands, feet, head, tail tips) are pre-selected as reasonable starting points.</p>
    <div class="bone-list" id="jg-bone-list"></div>
    <div class="field">
      <label>Stiffness <span class="val" id="jg-stiff-val">8.0</span></label>
      <input type="range" id="jg-stiff" min="1" max="30" step="0.5" value="8">
    </div>
    <div class="field">
      <label>Damping <span class="val" id="jg-damp-val">3.0</span></label>
      <input type="range" id="jg-damp" min="0.5" max="10" step="0.5" value="3">
    </div>
    <div class="field">
      <label>Amount <span class="val" id="jg-amount-val">1.00</span></label>
      <input type="range" id="jg-amount" min="0" max="3" step="0.1" value="1">
    </div>
    <p class="hint">Drag directly on a bone's handle (small dot) in the viewport above to flick it and watch the jiggle respond live - that's the fastest way to feel out stiffness/damping.</p>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="jg-apply">Apply</button>
    </div>
  `;

  const listEl = container.querySelector('#jg-bone-list');
  if (!skeleton) {
    listEl.innerHTML = '<div class="bone-row">No skeleton found.</div>';
  } else {
    for (const bone of skeleton.bones) {
      const row = document.createElement('label');
      row.className = 'bone-row';
      row.innerHTML = `<span>${bone.name}</span><input type="checkbox" data-bone="${bone.name}" ${SUGGESTED_JIGGLE_NAMES.has(bone.name) ? 'checked' : ''}>`;
      listEl.appendChild(row);
    }
  }

  const stiffSlider = container.querySelector('#jg-stiff');
  const dampSlider = container.querySelector('#jg-damp');
  const amountSlider = container.querySelector('#jg-amount');
  stiffSlider.addEventListener('input', () => container.querySelector('#jg-stiff-val').textContent = Number(stiffSlider.value).toFixed(1));
  dampSlider.addEventListener('input', () => container.querySelector('#jg-damp-val').textContent = Number(dampSlider.value).toFixed(1));
  amountSlider.addEventListener('input', () => container.querySelector('#jg-amount-val').textContent = Number(amountSlider.value).toFixed(2));

  function currentConfig() {
    const stiffness = Number(stiffSlider.value), damping = Number(dampSlider.value), amount = Number(amountSlider.value);
    const boneNames = Array.from(listEl.querySelectorAll('input[type=checkbox]:checked')).map((cb) => cb.dataset.bone);
    return boneNames.map((boneName) => ({ boneName, stiffness, damping, amount }));
  }

  // live preview: enable jiggle on the working copy immediately so orbiting/
  // idle motion shows the effect while the user tunes sliders
  function livePreview() {
    ctx.model.userData.jiggleEnabled = true;
    ctx.model.userData.jiggleBones = currentConfig();
  }
  listEl.addEventListener('change', livePreview);
  [stiffSlider, dampSlider, amountSlider].forEach((el) => el.addEventListener('input', livePreview));
  livePreview();
  ctx.preview(ctx.model, ctx.animations);

  // --- drag-to-test: route the drag through the SAME offset/velocity state
  // stepJiggleBone() already reads each frame, rather than setting the
  // bone's rotation directly - that way releasing the drag naturally springs
  // back through the existing, already-validated physics instead of leaving
  // a permanent pose change behind. ---
  let interaction = null;
  if (skeleton) {
    interaction = createBoneInteraction(ctx, skeleton, {
      onSelectBone: (bone) => {
        const cb = listEl.querySelector(`input[data-bone="${CSS.escape(bone.name)}"]`);
        if (cb && !cb.checked) { cb.checked = true; livePreview(); }
      },
      onDragBone: (bone, worldDeltaQuat, dx, dy) => {
        // apply visually now (immediate feedback while dragging) ...
        interaction.applyWorldSpaceDelta(bone, worldDeltaQuat);
        // ... and keep the spring's own bookkeeping in sync, so once released,
        // stepJiggleBone() continues smoothly FROM the dragged position and
        // pulls it back toward rest, instead of jumping.
        const ud = bone.userData;
        if (!ud._jiggleOffset) ud._jiggleOffset = { x: 0, z: 0 };
        if (!ud._jiggleVel) ud._jiggleVel = { x: 0, z: 0 };
        const e = new THREE.Euler().setFromQuaternion(worldDeltaQuat);
        ud._jiggleOffset.x = Math.max(-0.9, Math.min(0.9, ud._jiggleOffset.x + e.x));
        ud._jiggleOffset.z = Math.max(-0.9, Math.min(0.9, ud._jiggleOffset.z + e.z));
        ud._jiggleVel.x += dy * 0.4;
        ud._jiggleVel.z += dx * 0.4;
      },
    });
  }

  container.querySelector('#jg-apply').onclick = () => {
    interaction?.dispose();
    const configs = currentConfig();
    ctx.model.userData.jiggleEnabled = configs.length > 0;
    ctx.model.userData.jiggleBones = configs;
    apply(ctx.model, 'Jiggle');
  };

  const cleanup = () => interaction?.dispose();
  document.getElementById('sheet-close').addEventListener('click', cleanup, { once: true });
  document.getElementById('sheet-backdrop').addEventListener('click', cleanup, { once: true });
}
