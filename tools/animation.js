import * as THREE from 'three';

export const meta = {
  id: 'animation',
  name: 'Animation',
  icon: '▶',
  section: 'tools',
  description: 'Generates a few ready-to-use animation clips (idle, walk, wave) for the current skeleton.',
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
  const chest = findBone(skeleton, 'Chest');
  const head = findBone(skeleton, 'Head');
  const spine = findBone(skeleton, 'Spine');
  const mid = findBone(skeleton, 'Mid');
  const tip = findBone(skeleton, 'Tip');
  if (chest) tracks.push(quatTrack('Chest', times, [[0, 0, 0], [0, 0, 0.04], [0, 0, 0]]));
  if (head) tracks.push(quatTrack('Head', times, [[0, 0, 0], [0, 0, -0.03], [0, 0, 0]]));
  if (spine) tracks.push(quatTrack('Spine', times, [[0, 0, 0], [0, 0.02, 0], [0, 0, 0]]));
  if (mid) tracks.push(quatTrack('Mid', times, [[0, 0, 0], [0.06, 0, 0.06], [0, 0, 0]]));
  if (tip) tracks.push(quatTrack('Tip', times, [[0, 0, 0], [0.1, 0, -0.1], [0, 0, 0]]));
  if (tracks.length === 0) return null;
  return new THREE.AnimationClip('Idle', 3.0, tracks);
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
  if (tracks.length === 0) return null;
  return new THREE.AnimationClip('Walk', 1.0, tracks);
}

function buildWaveClip(skeleton) {
  const tracks = [];
  const times = [0, 0.4, 0.8, 1.2, 1.6, 2.0];
  const rArm = findBone(skeleton, 'RightArm');
  const rForeArm = findBone(skeleton, 'RightForeArm');
  if (!rArm) return null;
  tracks.push(quatTrack('RightArm', times, [[0, 0, 0], [0, 0, -1.3], [0, 0, -1.2], [0, 0, -1.35], [0, 0, -1.2], [0, 0, -1.3]]));
  if (rForeArm) tracks.push(quatTrack('RightForeArm', times, [[0, 0, 0], [0, 0, -0.3], [0, 0, 0.4], [0, 0, -0.3], [0, 0, 0.4], [0, 0, -0.3]]));
  return new THREE.AnimationClip('Wave', 2.0, tracks);
}

export function buildPanel(container, ctx, apply) {
  let skeleton = null;
  ctx.model.traverse((o) => { if (o.isSkinnedMesh && !skeleton) skeleton = o.skeleton; });

  container.innerHTML = `
    <p class="hint">Builds ready-to-play animation clips for the bones in this model. Clips are baked as real keyframe data, so they'll survive export and play in other engines too.</p>
    <div class="checkbox-row"><input type="checkbox" id="an-idle" checked><label for="an-idle">Idle (gentle sway)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="an-walk" checked><label for="an-walk">Walk cycle</label></div>
    <div class="checkbox-row"><input type="checkbox" id="an-wave" checked><label for="an-wave">Wave</label></div>
    <button type="button" class="btn btn-primary" id="an-generate">Generate</button>
    <div id="an-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn" id="an-apply" disabled>Apply</button>
    </div>
  `;

  const generateBtn = container.querySelector('#an-generate');
  const applyBtn = container.querySelector('#an-apply');
  const statusEl = container.querySelector('#an-status');
  let resultClips = null;

  generateBtn.onclick = () => {
    if (!skeleton) { statusEl.textContent = 'No skeleton found on this model.'; return; }
    const clips = [];
    if (container.querySelector('#an-idle').checked) { const c = buildIdleClip(skeleton); if (c) clips.push(c); }
    if (container.querySelector('#an-walk').checked) { const c = buildWalkClip(skeleton); if (c) clips.push(c); }
    if (container.querySelector('#an-wave').checked) { const c = buildWaveClip(skeleton); if (c) clips.push(c); }

    if (clips.length === 0) {
      statusEl.textContent = "None of the selected clips matched this skeleton's bone names - try the Humanoid rig template for Walk/Wave, or Idle works with most rigs.";
      applyBtn.disabled = true;
      return;
    }
    resultClips = clips;
    ctx.preview(ctx.model, clips);
    statusEl.textContent = `Generated: ${clips.map((c) => c.name).join(', ')}. Use the play controls above the viewport to preview.`;
    applyBtn.disabled = false;
  };

  applyBtn.onclick = () => {
    if (!resultClips) return;
    apply(ctx.model, 'Animation', resultClips);
  };
}
