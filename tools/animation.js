import * as THREE from 'three';
import { createBoneInteraction } from './_boneDrag.js';

export const meta = {
  id: 'animation',
  name: 'Animation',
  icon: '▶',
  section: 'tools',
  description: 'Quick preset clips, or drag bones directly in the viewport to record your own.',
  requires: ['hasSkeleton'],
  requiresLabel: 'Needs bones/joints first',
};

function findBone(skeleton, name) {
  return skeleton.bones.find((b) => b.name === name) || null;
}
function quatTrack(boneName, times, eulerXYZList) {
  const values = [];
  const q = new THREE.Quaternion();
  for (const [x, y, z] of eulerXYZList) {
    q.setFromEuler(new THREE.Euler(x, y, z));
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
}
function posTrack(boneName, times, positions) {
  const values = [];
  for (const [x, y, z] of positions) values.push(x, y, z);
  return new THREE.VectorKeyframeTrack(`${boneName}.position`, times, values);
}

function buildIdleClip(skeleton) {
  const tracks = [];
  const times = [0, 1.5, 3.0];
  const chest = findBone(skeleton, 'Chest'), head = findBone(skeleton, 'Head'), spine = findBone(skeleton, 'Spine');
  const mid = findBone(skeleton, 'Mid'), tip = findBone(skeleton, 'Tip');
  if (chest) tracks.push(quatTrack('Chest', times, [[0, 0, 0], [0, 0, 0.04], [0, 0, 0]]));
  if (head) tracks.push(quatTrack('Head', times, [[0, 0, 0], [0, 0, -0.03], [0, 0, 0]]));
  if (spine) tracks.push(quatTrack('Spine', times, [[0, 0, 0], [0, 0.02, 0], [0, 0, 0]]));
  if (mid) tracks.push(quatTrack('Mid', times, [[0, 0, 0], [0.06, 0, 0.06], [0, 0, 0]]));
  if (tip) tracks.push(quatTrack('Tip', times, [[0, 0, 0], [0.1, 0, -0.1], [0, 0, 0]]));
  return tracks.length ? new THREE.AnimationClip('Idle', 3.0, tracks) : null;
}
function buildWalkClip(skeleton) {
  const tracks = [];
  const times = [0, 0.25, 0.5, 0.75, 1.0];
  const lUpLeg = findBone(skeleton, 'LeftUpLeg'), rUpLeg = findBone(skeleton, 'RightUpLeg');
  const lArm = findBone(skeleton, 'LeftArm'), rArm = findBone(skeleton, 'RightArm');
  const hips = findBone(skeleton, 'Hips');
  if (lUpLeg) tracks.push(quatTrack('LeftUpLeg', times, [[0.5, 0, 0], [0, 0, 0], [-0.5, 0, 0], [0, 0, 0], [0.5, 0, 0]]));
  if (rUpLeg) tracks.push(quatTrack('RightUpLeg', times, [[-0.5, 0, 0], [0, 0, 0], [0.5, 0, 0], [0, 0, 0], [-0.5, 0, 0]]));
  if (lArm) tracks.push(quatTrack('LeftArm', times, [[-0.4, 0, 0], [0, 0, 0], [0.4, 0, 0], [0, 0, 0], [-0.4, 0, 0]]));
  if (rArm) tracks.push(quatTrack('RightArm', times, [[0.4, 0, 0], [0, 0, 0], [-0.4, 0, 0], [0, 0, 0], [0.4, 0, 0]]));
  if (hips) {
    const b = hips.position;
    tracks.push(posTrack('Hips', times, [[b.x, b.y, b.z], [b.x, b.y + 0.03, b.z], [b.x, b.y, b.z], [b.x, b.y + 0.03, b.z], [b.x, b.y, b.z]]));
  }
  return tracks.length ? new THREE.AnimationClip('Walk', 1.0, tracks) : null;
}
function buildWaveClip(skeleton) {
  const rArm = findBone(skeleton, 'RightArm');
  if (!rArm) return null;
  const times = [0, 0.4, 0.8, 1.2, 1.6, 2.0];
  const tracks = [quatTrack('RightArm', times, [[0, 0, 0], [0, 0, -1.3], [0, 0, -1.2], [0, 0, -1.35], [0, 0, -1.2], [0, 0, -1.3]])];
  const rForeArm = findBone(skeleton, 'RightForeArm');
  if (rForeArm) tracks.push(quatTrack('RightForeArm', times, [[0, 0, 0], [0, 0, -0.3], [0, 0, 0.4], [0, 0, -0.3], [0, 0, 0.4], [0, 0, -0.3]]));
  return new THREE.AnimationClip('Wave', 2.0, tracks);
}

/* Validated in test_keyframe_clip.mjs: exact match at the start/end poses,
   correct slerp interpolation at the midpoint, graceful handling of a bone
   missing from some keyframes, and a guard against fewer than 2 keyframes. */
function buildClipFromKeyframes(keyframes, clipName) {
  if (keyframes.length < 2) return null;
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const boneNames = Object.keys(sorted[0].poses);
  const times = sorted.map((k) => k.time);
  const tracks = [];
  for (const boneName of boneNames) {
    const values = [];
    let complete = true;
    for (const kf of sorted) {
      const q = kf.poses[boneName];
      if (!q) { complete = false; break; }
      values.push(q[0], q[1], q[2], q[3]);
    }
    if (!complete) continue;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
  }
  if (tracks.length === 0) return null;
  return new THREE.AnimationClip(clipName, times[times.length - 1], tracks);
}

function captureCurrentPose(skeleton) {
  const poses = {};
  for (const bone of skeleton.bones) {
    poses[bone.name] = [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w];
  }
  return poses;
}

export function buildPanel(container, ctx, apply) {
  let skeleton = null;
  ctx.model.traverse((o) => { if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton; });

  container.innerHTML = `
    <h4 style="margin:0 0 8px;font-family:var(--font-display);font-size:13px;">Quick presets</h4>
    <div class="checkbox-row"><input type="checkbox" id="an-idle" checked><label for="an-idle">Idle (gentle sway)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="an-walk" checked><label for="an-walk">Walk cycle</label></div>
    <div class="checkbox-row"><input type="checkbox" id="an-wave" checked><label for="an-wave">Wave</label></div>
    <button type="button" class="btn" id="an-generate">Generate presets</button>

    <h4 style="margin:18px 0 8px;font-family:var(--font-display);font-size:13px;">Custom - pose it yourself</h4>
    <p class="hint">Drag any bone's handle (small dot) directly in the viewport above to pose it. Capture a few poses at different times, then build a clip that moves between them.</p>
    <div class="field-row" style="margin-bottom:10px;">
      <div class="field" style="flex:1;margin-bottom:0;">
        <label>Time (seconds)</label>
        <input type="number" id="an-kf-time" min="0" step="0.25" value="0" style="background:var(--panel-raised);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 10px;width:100%;">
      </div>
      <button type="button" class="btn" id="an-capture" style="width:auto;flex:1;align-self:flex-end;">Capture Pose</button>
    </div>
    <div id="an-kf-list" class="bone-list" style="display:none;"></div>
    <div class="field" id="an-clipname-field" style="display:none;">
      <label>Clip name</label>
      <input type="text" id="an-clipname" value="Custom" style="background:var(--panel-raised);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px 10px;width:100%;">
    </div>
    <button type="button" class="btn" id="an-build" style="display:none;">Build Clip from Poses</button>

    <div id="an-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn btn-primary" id="an-apply" disabled>Apply all clips</button>
    </div>
  `;

  const statusEl = container.querySelector('#an-status');
  const applyBtn = container.querySelector('#an-apply');
  let presetClips = [];
  let customClips = [];
  const keyframes = [];

  function allClips() { return [...presetClips, ...customClips]; }
  function refreshApplyState() {
    applyBtn.disabled = allClips().length === 0;
  }

  if (!skeleton) {
    statusEl.textContent = 'No skeleton found on this model.';
  } else {
    container.querySelector('#an-generate').onclick = () => {
      const clips = [];
      if (container.querySelector('#an-idle').checked) { const c = buildIdleClip(skeleton); if (c) clips.push(c); }
      if (container.querySelector('#an-walk').checked) { const c = buildWalkClip(skeleton); if (c) clips.push(c); }
      if (container.querySelector('#an-wave').checked) { const c = buildWaveClip(skeleton); if (c) clips.push(c); }
      presetClips = clips;
      ctx.preview(ctx.model, allClips());
      statusEl.textContent = clips.length
        ? `Generated: ${clips.map((c) => c.name).join(', ')}.`
        : "None of the selected presets matched this skeleton's bone names - try the Humanoid rig template, or use Custom posing below instead.";
      refreshApplyState();
    };

    const timeInput = container.querySelector('#an-kf-time');
    const kfListEl = container.querySelector('#an-kf-list');
    const buildBtn = container.querySelector('#an-build');
    const clipNameField = container.querySelector('#an-clipname-field');
    const clipNameInput = container.querySelector('#an-clipname');

    function renderKeyframeList() {
      if (keyframes.length === 0) {
        kfListEl.style.display = 'none';
        buildBtn.style.display = 'none';
        clipNameField.style.display = 'none';
        return;
      }
      kfListEl.style.display = 'block';
      buildBtn.style.display = keyframes.length >= 2 ? 'block' : 'none';
      clipNameField.style.display = keyframes.length >= 2 ? 'block' : 'none';
      kfListEl.innerHTML = keyframes
        .map((kf, i) => `<div class="bone-row"><span>t = ${kf.time.toFixed(2)}s</span><button type="button" class="icon-btn" data-idx="${i}">✕</button></div>`)
        .join('');
      kfListEl.querySelectorAll('button[data-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          keyframes.splice(Number(btn.dataset.idx), 1);
          renderKeyframeList();
        });
      });
    }

    container.querySelector('#an-capture').onclick = () => {
      const time = Number(timeInput.value) || 0;
      keyframes.push({ time, poses: captureCurrentPose(skeleton) });
      timeInput.value = (time + 1).toFixed(2);
      renderKeyframeList();
      statusEl.textContent = `Captured pose at t=${time.toFixed(2)}s (${keyframes.length} total).`;
    };

    buildBtn.onclick = () => {
      const name = clipNameInput.value.trim() || 'Custom';
      const clip = buildClipFromKeyframes(keyframes, name);
      if (!clip) { statusEl.textContent = 'Could not build a clip from these poses.'; return; }
      customClips = [...customClips.filter((c) => c.name !== name), clip];
      ctx.preview(ctx.model, allClips());
      statusEl.textContent = `Built "${name}" (${keyframes.length} poses, ${clip.duration.toFixed(2)}s). Use the play controls above to preview.`;
      refreshApplyState();
    };

    // bone handles + direct drag-to-pose, active for the whole panel session
    const interaction = createBoneInteraction(ctx, skeleton, {
      onDragBone: (bone, worldDeltaQuat) => interaction.applyWorldSpaceDelta(bone, worldDeltaQuat),
    });
    const cleanup = () => interaction.dispose();
    document.getElementById('sheet-close').addEventListener('click', cleanup, { once: true });
    document.getElementById('sheet-backdrop').addEventListener('click', cleanup, { once: true });

    applyBtn.addEventListener('click', cleanup, { once: true });
  }

  applyBtn.onclick = () => {
    if (allClips().length === 0) return;
    apply(ctx.model, 'Animation', allClips());
  };
}
