import * as THREE from 'three';

export const meta = {
  id: 'rig',
  name: 'Rig (Bones)',
  icon: '𓆚',
  section: 'tools',
  description: 'Places a skeleton scaled to the model and computes skin weights automatically.',
  requires: ['hasGeometry'],
  requiresLabel: 'Needs a model first',
};

/* Validated separately in test_skin.mjs: inverse-square distance to the 2
   nearest bone segments, confirmed to approach ~100% at true on-axis points
   and give a clean 50/50 blend exactly at a joint. This is a heuristic
   "closest bone wins" skin - a reasonable stand-in for full weight-painting,
   not a claim of matching a professional rigger's quality. */
function closestPointOnSegment(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const len2 = ab.lengthSq();
  if (len2 < 1e-10) return a.clone();
  let t = new THREE.Vector3().subVectors(p, a).dot(ab) / len2;
  t = Math.max(0, Math.min(1, t));
  return new THREE.Vector3().copy(a).addScaledVector(ab, t);
}

function computeSkinWeights(positions, segments) {
  const count = positions.count;
  const skinIndex = new Float32Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const eps = 1e-4;
  for (let i = 0; i < count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(positions, i);
    const dists = segments.map((seg, si) => ({ si, d: p.distanceTo(closestPointOnSegment(p, seg.start, seg.end)) }));
    dists.sort((a, b) => a.d - b.d);
    const top2 = dists.slice(0, 2);
    const w0 = 1 / Math.pow(top2[0].d + eps, 2);
    const w1 = top2[1] ? 1 / Math.pow(top2[1].d + eps, 2) : 0;
    const sum = w0 + w1;
    skinIndex[i * 4] = segments[top2[0].si].boneIndex;
    skinWeight[i * 4] = w0 / sum;
    if (top2[1]) {
      skinIndex[i * 4 + 1] = segments[top2[1].si].boneIndex;
      skinWeight[i * 4 + 1] = w1 / sum;
    }
  }
  return { skinIndex, skinWeight };
}

function buildHumanoidTemplate(min, max) {
  const size = new THREE.Vector3().subVectors(max, min);
  const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2;
  const h = size.y || 1, w = size.x || 1;
  const y = (f) => min.y + h * f;
  return [
    { name: 'Hips', pos: [cx, y(0.50), cz], parent: null },
    { name: 'Spine', pos: [cx, y(0.62), cz], parent: 'Hips' },
    { name: 'Chest', pos: [cx, y(0.74), cz], parent: 'Spine' },
    { name: 'Neck', pos: [cx, y(0.88), cz], parent: 'Chest' },
    { name: 'Head', pos: [cx, y(0.95), cz], parent: 'Neck' },
    { name: 'HeadTop', pos: [cx, y(1.0), cz], parent: 'Head' },
    { name: 'LeftShoulder', pos: [cx - w * 0.12, y(0.80), cz], parent: 'Chest' },
    { name: 'LeftArm', pos: [cx - w * 0.35, y(0.78), cz], parent: 'LeftShoulder' },
    { name: 'LeftForeArm', pos: [cx - w * 0.48, y(0.60), cz], parent: 'LeftArm' },
    { name: 'LeftHand', pos: [cx - w * 0.52, y(0.45), cz], parent: 'LeftForeArm' },
    { name: 'RightShoulder', pos: [cx + w * 0.12, y(0.80), cz], parent: 'Chest' },
    { name: 'RightArm', pos: [cx + w * 0.35, y(0.78), cz], parent: 'RightShoulder' },
    { name: 'RightForeArm', pos: [cx + w * 0.48, y(0.60), cz], parent: 'RightArm' },
    { name: 'RightHand', pos: [cx + w * 0.52, y(0.45), cz], parent: 'RightForeArm' },
    { name: 'LeftUpLeg', pos: [cx - w * 0.12, y(0.48), cz], parent: 'Hips' },
    { name: 'LeftLeg', pos: [cx - w * 0.13, y(0.25), cz], parent: 'LeftUpLeg' },
    { name: 'LeftFoot', pos: [cx - w * 0.13, y(0.02), cz], parent: 'LeftLeg' },
    { name: 'RightUpLeg', pos: [cx + w * 0.12, y(0.48), cz], parent: 'Hips' },
    { name: 'RightLeg', pos: [cx + w * 0.13, y(0.25), cz], parent: 'RightUpLeg' },
    { name: 'RightFoot', pos: [cx + w * 0.13, y(0.02), cz], parent: 'RightLeg' },
  ];
}

function buildSimpleTemplate(min, max) {
  const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2;
  return [
    { name: 'Base', pos: [cx, min.y, cz], parent: null },
    { name: 'Mid', pos: [cx, (min.y + max.y) / 2, cz], parent: 'Base' },
    { name: 'Tip', pos: [cx, max.y, cz], parent: 'Mid' },
  ];
}

function buildSkeletonFromTemplate(defs) {
  const boneMap = new Map();
  const boneList = [];
  for (const def of defs) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    boneMap.set(def.name, bone);
    boneList.push(bone);
  }
  const worldPosOf = new Map(defs.map((d) => [d.name, new THREE.Vector3(...d.pos)]));
  let root = null;
  for (const def of defs) {
    const bone = boneMap.get(def.name);
    const worldPos = worldPosOf.get(def.name);
    if (def.parent) {
      const parentWorldPos = worldPosOf.get(def.parent);
      bone.position.copy(worldPos).sub(parentWorldPos);
      boneMap.get(def.parent).add(bone);
    } else {
      bone.position.copy(worldPos);
      root = bone;
    }
  }
  root.updateMatrixWorld(true);
  return { skeleton: new THREE.Skeleton(boneList), root, boneMap, worldPosOf };
}

function buildSegments(defs, boneMap, worldPosOf) {
  // one segment per bone: from the bone's own head to its first child's head
  // (leaf bones - hands, feet, head-top - get a short nominal segment so
  // they still have a well-defined influence region)
  const boneIndexOf = new Map(defs.map((d, i) => [d.name, i]));
  const childOf = new Map();
  for (const def of defs) if (def.parent) childOf.set(def.parent, def.name);
  return defs.map((def) => {
    const start = worldPosOf.get(def.name);
    const childName = childOf.get(def.name);
    const end = childName ? worldPosOf.get(childName) : start.clone().add(new THREE.Vector3(0, 0.05, 0));
    return { boneIndex: boneIndexOf.get(def.name), start, end };
  });
}

export function buildPanel(container, ctx, apply) {
  const alreadyRigged = ctx.capabilities.hasSkeleton;
  container.innerHTML = `
    <p class="hint">${alreadyRigged ? 'This model already has a skeleton - generating a new one replaces it, and any existing animation will need to be re-applied afterward.' : 'Places a skeleton sized to this model and computes vertex weights automatically.'}</p>
    <div class="field">
      <label>Template</label>
      <select id="rig-template">
        <option value="humanoid">Humanoid (20 bones - arms, legs, spine, head)</option>
        <option value="simple">Simple (3 bones - base / mid / tip)</option>
      </select>
    </div>
    <p class="hint">Humanoid works best on a roughly upright, person-shaped model. For props, tails, or anything else, use Simple.</p>
    <button type="button" class="btn btn-primary" id="rig-generate">Generate Rig</button>
    <div id="rig-status" class="hint"></div>
    <div class="btn-row">
      <button type="button" class="btn" id="rig-apply" disabled>Apply</button>
    </div>
  `;

  const templateSelect = container.querySelector('#rig-template');
  const generateBtn = container.querySelector('#rig-generate');
  const applyBtn = container.querySelector('#rig-apply');
  const statusEl = container.querySelector('#rig-status');
  let resultGroup = null;

  generateBtn.onclick = () => {
    if (!ctx.model) return;
    statusEl.textContent = 'Rigging…';
    setTimeout(() => {
      try {
        const box = new THREE.Box3().setFromObject(ctx.model);
        if (box.isEmpty()) { statusEl.textContent = 'Model has no geometry to rig.'; return; }

        const defs = templateSelect.value === 'simple' ? buildSimpleTemplate(box.min, box.max) : buildHumanoidTemplate(box.min, box.max);
        const { skeleton, root, boneMap, worldPosOf } = buildSkeletonFromTemplate(defs);
        const segments = buildSegments(defs, boneMap, worldPosOf);

        let meshCount = 0;
        const meshesToConvert = [];
        ctx.model.traverse((obj) => { if (obj.isMesh) meshesToConvert.push(obj); });

        for (const obj of meshesToConvert) {
          const geo = obj.geometry;
          const { skinIndex, skinWeight } = computeSkinWeights(geo.attributes.position, segments);
          geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
          geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));

          const skinned = new THREE.SkinnedMesh(geo, obj.material);
          skinned.name = obj.name;
          skinned.bind(skeleton);
          obj.parent.add(skinned);
          obj.parent.remove(obj);
          meshCount++;
        }

        ctx.model.add(root);
        resultGroup = ctx.model;
        ctx.preview(resultGroup, []); // clear any stale animation preview - old clips won't match a new skeleton
        statusEl.textContent = `Rigged ${meshCount} mesh part${meshCount === 1 ? '' : 's'} with ${defs.length} bones.`;
        applyBtn.disabled = false;
      } catch (err) {
        statusEl.textContent = 'Rigging failed: ' + (err?.message || err);
        ctx.showToast('Rig failed - see details in the panel', true);
      }
    }, 20);
  };

  applyBtn.onclick = () => {
    if (!resultGroup) return;
    // re-rigging invalidates any previous animation clips (new bone objects/names)
    apply(resultGroup, 'Rig (Bones)', []);
  };
}
