import * as THREE from 'three';

/**
 * Adds small visible handle spheres at each bone (bones themselves have no
 * geometry) and wires up pointer events on the shared viewport so the user
 * can tap to select a bone and drag to rotate it - used for jiggle testing
 * and animation posing alike. The caller decides what a drag actually DOES
 * (jiggle.js injects it as a spring impulse; animation.js applies it as a
 * direct pose change) via the onDragBone callback; this module only owns
 * picking, event wiring, and the world-space-correct rotation math.
 *
 * Returns { dispose(), getSelectedBone() }.
 */
export function createBoneInteraction(ctx, skeleton, { onSelectBone, onDragBone, onDragEnd } = {}) {
  const { camera, renderer, controls } = ctx.viewport;
  const canvasEl = renderer.domElement;

  // --- visual handles: one small sphere per bone, parented to the bone so
  // it automatically follows any pose/animation ---
  const handleGeo = new THREE.SphereGeometry(1, 10, 8);
  const handles = new Map(); // bone -> Mesh
  let modelSize = 1;
  skeleton.bones.forEach((b) => { modelSize = Math.max(modelSize, b.position.length()); });
  const handleRadius = Math.max(modelSize * 0.035, 0.01);

  for (const bone of skeleton.bones) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x4fd1c5, depthTest: false, transparent: true, opacity: 0.85 });
    const handle = new THREE.Mesh(handleGeo, mat);
    handle.scale.setScalar(handleRadius);
    handle.renderOrder = 999;
    bone.add(handle);
    handles.set(bone, handle);
  }

  function setSelected(bone) {
    for (const [b, h] of handles) h.material.color.set(b === bone ? 0xf2a65a : 0x4fd1c5);
  }

  function pickNearestBone(clientX, clientY, maxPixelDist = 36) {
    const rect = canvasEl.getBoundingClientRect();
    let closest = null, closestDist = Infinity;
    const p = new THREE.Vector3();
    for (const bone of skeleton.bones) {
      bone.getWorldPosition(p);
      p.project(camera);
      const px = (p.x * 0.5 + 0.5) * rect.width + rect.left;
      const py = (-p.y * 0.5 + 0.5) * rect.height + rect.top;
      const d = Math.hypot(px - clientX, py - clientY);
      if (d < closestDist) { closestDist = d; closest = bone; }
    }
    return closestDist <= maxPixelDist ? closest : null;
  }

  // Applies a WORLD-space rotation delta to a bone's LOCAL quaternion, so the
  // bone's resulting world orientation is worldDelta * oldWorldOrientation
  // regardless of the parent chain's own rotation. Verified in
  // test_bonedrag_math.mjs against a deliberately non-trivial rotated
  // hierarchy (root + parent + child all independently rotated). Exported so
  // callers that DO want direct pose-setting (animation.js) can use it;
  // callers that want to route rotation through other state instead
  // (jiggle.js, through its spring offset) can ignore it and only use the
  // raw worldDelta/dx/dy passed to onDragBone.
  function applyWorldSpaceDelta(bone, worldDeltaQuat) {
    const parentWorldQuat = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentWorldQuat);
    const localDelta = parentWorldQuat.clone().invert().multiply(worldDeltaQuat).multiply(parentWorldQuat);
    bone.quaternion.premultiply(localDelta);
  }

  let selectedBone = null;
  let dragging = false;
  let lastX = 0, lastY = 0;
  const SENSITIVITY = 0.012; // radians per pixel

  // Disabled for the whole interaction session, not reactively inside
  // onPointerDown - OrbitControls' own pointerdown listener was registered
  // earlier (in app.js, before any tool panel exists), so it always runs
  // first and would already be tracking a rotation drag by the time
  // `enabled` flips reactively. Trade-off: the camera can't be orbited while
  // this panel is open - close it to reposition the view, then reopen.
  controls.enabled = false;

  function onPointerDown(e) {
    const bone = pickNearestBone(e.clientX, e.clientY);
    if (!bone) return;
    selectedBone = bone;
    setSelected(bone);
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    onSelectBone?.(bone);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging || !selectedBone) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;

    const worldUp = new THREE.Vector3(0, 1, 0);
    const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const yaw = new THREE.Quaternion().setFromAxisAngle(worldUp, -dx * SENSITIVITY);
    const pitch = new THREE.Quaternion().setFromAxisAngle(cameraRight, -dy * SENSITIVITY);
    const worldDelta = yaw.multiply(pitch);

    // NOTE: does NOT auto-apply worldDelta to the bone - the caller decides
    // how (see applyWorldSpaceDelta export vs. jiggle.js's offset-routing).
    onDragBone?.(selectedBone, worldDelta, dx, dy);
  }

  function onPointerUp() {
    if (dragging) onDragEnd?.(selectedBone);
    dragging = false;
  }

  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  function dispose() {
    canvasEl.removeEventListener('pointerdown', onPointerDown);
    canvasEl.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    controls.enabled = true;
    for (const [bone, handle] of handles) {
      bone.remove(handle);
      handle.material.dispose();
    }
    handleGeo.dispose();
  }

  return { dispose, getSelectedBone: () => selectedBone, applyWorldSpaceDelta };
}
