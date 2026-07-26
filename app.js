import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

import * as importModelTool from './tools/importModel.js';
import * as imageTo3DTool from './tools/imageTo3D.js';
import * as uvUnwrapTool from './tools/uvUnwrap.js';
import * as meshRepairTool from './tools/meshRepair.js';
import * as illuminationTool from './tools/illumination.js';
import * as textureTool from './tools/texture.js';
import * as rigTool from './tools/rig.js';
import * as animationTool from './tools/animation.js';
import * as jiggleTool from './tools/jiggle.js';
import * as sliceTool from './tools/slice.js';

const TOOLS = [
  importModelTool, imageTo3DTool, uvUnwrapTool, meshRepairTool,
  illuminationTool, textureTool, rigTool, animationTool, jiggleTool, sliceTool,
];

/* =========================================================================
   STATE
   In-memory only, on purpose: a real page refresh must wipe everything
   (per spec), and a plain JS array does that automatically with zero extra
   code. "Back" is an explicit bottom-bar button, not the phone's hardware
   back gesture - simpler and far more robust than hijacking browser history,
   and it satisfies the same requirement (revert one step; new work from a
   back-'d state truncates whatever was ahead of it).
   Each history entry: { label, group: THREE.Group, animations: THREE.AnimationClip[] }
   IMPORTANT: animations are kept OUTSIDE group.userData on purpose - three.js
   clones userData via JSON.parse(JSON.stringify(...)), which would silently
   turn real AnimationClip instances into dead plain objects on every clone.
   ========================================================================= */
let history = [];
let historyIndex = -1;
let activePreviewGroup = null;   // uncommitted model shown while a tool panel is open

function currentEntry() { return historyIndex >= 0 ? history[historyIndex] : null; }

/* =========================================================================
   THREE.js SCENE
   ========================================================================= */
const canvas = document.getElementById('viewer-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(2.4, 2, 3.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x1a1410, 1.1);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 5, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
fill.position.set(-4, 2, -3);
scene.add(fill);

const modelRoot = new THREE.Group();
scene.add(modelRoot);

function resizeRenderer() {
  const wrap = document.getElementById('viewer-canvas-wrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resizeRenderer).observe(document.getElementById('viewer-canvas-wrap'));
resizeRenderer();

function frameCameraTo(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim * 1.9;
  camera.position.set(center.x + dist * 0.55, center.y + dist * 0.45, center.z + dist * 0.75);
  camera.near = Math.max(maxDim / 100, 0.001);
  camera.far = maxDim * 30;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

/* ---- Animation playback (mixer only exists for the COMMITTED current state) ---- */
let mixer = null;
let currentAction = null;
let isPlaying = true;
const animControlsEl = document.getElementById('anim-controls');
const animSelectEl = document.getElementById('anim-clip-select');
const animPlayBtn = document.getElementById('anim-play-btn');

function setupAnimationHUD(group, animations) {
  if (!animations || animations.length === 0) {
    animControlsEl.classList.add('hidden');
    mixer = null;
    currentAction = null;
    return;
  }
  animControlsEl.classList.remove('hidden');
  mixer = new THREE.AnimationMixer(group);
  animSelectEl.innerHTML = animations.map((a, i) => `<option value="${i}">${a.name || ('Clip ' + (i + 1))}</option>`).join('');
  function playIndex(i) {
    if (currentAction) currentAction.stop();
    currentAction = mixer.clipAction(animations[i]);
    currentAction.reset().play();
    currentAction.paused = !isPlaying;
  }
  playIndex(0);
  animSelectEl.onchange = () => playIndex(Number(animSelectEl.value));
  isPlaying = true;
  animPlayBtn.textContent = '⏸';
  animPlayBtn.onclick = () => {
    isPlaying = !isPlaying;
    animPlayBtn.textContent = isPlaying ? '⏸' : '▶';
    if (currentAction) currentAction.paused = !isPlaying;
  };
}

function displayGroup(group, animations = []) {
  while (modelRoot.children.length) modelRoot.remove(modelRoot.children[0]);
  document.getElementById('empty-state').classList.toggle('hidden', !!group);
  if (group) {
    modelRoot.add(group);
    frameCameraTo(group);
  }
  setupAnimationHUD(group, animations);
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (mixer) mixer.update(dt);
  const displayed = activePreviewGroup || currentEntry()?.group || null;
  if (displayed?.userData?.jiggleEnabled) {
    jiggleTool.updateJiggle(displayed, dt);
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

/* =========================================================================
   CAPABILITIES
   ========================================================================= */
function getCapabilities(group, animations) {
  const caps = { hasGeometry: false, hasUV: false, hasSkeleton: false, hasAnimations: false, partCount: 0, vertCount: 0, triCount: 0 };
  if (!group) return caps;
  group.traverse((obj) => {
    if (obj.isMesh) {
      caps.partCount++;
      const geo = obj.geometry;
      if (geo?.attributes?.position) caps.vertCount += geo.attributes.position.count;
      caps.triCount += geo?.index ? geo.index.count / 3 : (geo?.attributes?.position ? geo.attributes.position.count / 3 : 0);
      if (geo?.attributes?.uv) caps.hasUV = true;
      if (obj.isSkinnedMesh) caps.hasSkeleton = true;
    }
  });
  caps.hasGeometry = caps.partCount > 0;
  caps.hasAnimations = !!(animations && animations.length > 0);
  return caps;
}

function cloneModel(group) {
  const cloned = skeletonClone(group);
  // IMPORTANT: three.js's default clone shares geometry/material references
  // rather than deep-copying them (confirmed against the actual Mesh.copy()
  // source: `this.material = source.material; this.geometry = source.geometry;`).
  // Any tool that mutates geometry/material IN PLACE - illumination's
  // setAttribute('color', ...), texture-paint drawing onto the canvas behind
  // a texture - would otherwise silently edit the CURRENTLY COMMITTED history
  // entry too, since it's the literal same object. Cloning here, once,
  // centrally, means every tool gets an independently-mutable copy for free.
  cloned.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.geometry = obj.geometry.clone();
    const cloneMaterial = (mat) => {
      const m = mat.clone();
      if (m.map && m.map.image instanceof HTMLCanvasElement) {
        const oldCanvas = m.map.image;
        const newCanvas = document.createElement('canvas');
        newCanvas.width = oldCanvas.width;
        newCanvas.height = oldCanvas.height;
        newCanvas.getContext('2d').drawImage(oldCanvas, 0, 0);
        const newTex = m.map.clone();
        newTex.image = newCanvas;
        newTex.needsUpdate = true;
        m.map = newTex;
      }
      return m;
    };
    obj.material = Array.isArray(obj.material) ? obj.material.map(cloneMaterial) : cloneMaterial(obj.material);
  });
  return cloned;
}

/* =========================================================================
   TOAST
   ========================================================================= */
let toastTimer = null;
function showToast(message, isWarn = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('toast-warn', isWarn);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* =========================================================================
   HISTORY / COMMIT
   ========================================================================= */
function commitStep(newGroup, label, animations) {
  const animsToStore = animations !== undefined ? animations : (currentEntry()?.animations || []);
  if (historyIndex < history.length - 1) history = history.slice(0, historyIndex + 1);
  history.push({ label, group: newGroup, animations: animsToStore, timestamp: Date.now() });
  historyIndex = history.length - 1;
  closeSheetImmediate();
  renderCurrent();
  showToast(`${label} applied`);
}

function goBack() {
  closeSheetImmediate();
  if (historyIndex >= 0) {
    historyIndex--;
    renderCurrent();
  }
}

function resetAll() {
  closeSheetImmediate();
  history = [];
  historyIndex = -1;
  renderCurrent();
}

function renderCurrent() {
  const entry = currentEntry();
  displayGroup(entry?.group ?? null, entry?.animations ?? []);
  updateHUD();
  renderCards();
  updateActionBar();
}

/* =========================================================================
   HUD
   ========================================================================= */
function updateHUD() {
  const entry = currentEntry();
  const caps = getCapabilities(entry?.group ?? null, entry?.animations ?? []);
  const g = !!entry;
  document.getElementById('hud-verts').textContent = g ? `verts ${caps.vertCount}` : 'verts —';
  document.getElementById('hud-tris').textContent = g ? `tris ${Math.round(caps.triCount)}` : 'tris —';
  document.getElementById('hud-uv').textContent = `UV ${g ? (caps.hasUV ? 'yes' : 'no') : '—'}`;
  document.getElementById('hud-skeleton').textContent = `rig ${g ? (caps.hasSkeleton ? 'yes' : 'no') : '—'}`;
  document.getElementById('hud-anim').textContent = `anim ${g ? (caps.hasAnimations ? caps_clip_count(entry) : 'no') : '—'}`;
  document.getElementById('hud-parts').textContent = `parts ${g ? caps.partCount : '—'}`;
}
function caps_clip_count(entry) { return entry?.animations?.length ?? 0; }

function updateActionBar() {
  document.getElementById('btn-undo').disabled = historyIndex < 0;
  document.getElementById('btn-save').disabled = historyIndex < 0;
  document.getElementById('btn-reset').disabled = history.length === 0;
}

/* =========================================================================
   CARDS
   ========================================================================= */
function renderCards() {
  const startGrid = document.getElementById('start-grid');
  const toolsGrid = document.getElementById('tools-grid');
  startGrid.innerHTML = '';
  toolsGrid.innerHTML = '';
  const entry = currentEntry();
  const caps = getCapabilities(entry?.group ?? null, entry?.animations ?? []);

  for (const tool of TOOLS) {
    const requires = tool.meta.requires || [];
    const enabled = requires.every((r) => caps[r]);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card' + (enabled ? '' : ' card-disabled');
    card.innerHTML = `
      <div class="card-icon">${tool.meta.icon}</div>
      <div class="card-name">${tool.meta.name}</div>
      <div class="card-desc">${tool.meta.description}</div>
      ${enabled ? '' : `<div class="card-requirement">${tool.meta.requiresLabel || 'Needs a model first'}</div>`}
    `;
    card.addEventListener('click', () => {
      if (!enabled) {
        showToast(tool.meta.requiresLabel || 'Not available yet for this model', true);
        return;
      }
      openToolPanel(tool);
    });
    (tool.meta.section === 'start' ? startGrid : toolsGrid).appendChild(card);
  }
}

/* =========================================================================
   TOOL PANEL (inline section that hosts each tool's own UI - not an overlay)
   ========================================================================= */
const panelEl = document.getElementById('tool-panel');
const sheetTitleEl = document.getElementById('sheet-title');
const sheetBodyEl = document.getElementById('sheet-body');
let currentOpenToolId = null;
let activeCleanup = null; // whatever the currently-open tool's buildPanel() returned, if anything

function openToolPanel(tool) {
  const reopeningSame = currentOpenToolId === tool.meta.id;
  closeSheetImmediate(); // always tear down whatever was open first (calls its cleanup, if any)
  if (reopeningSame) { return; } // tapping the open card again just closes it

  const entry = currentEntry();
  const sourceGroup = entry?.group ?? null;
  const workingCopy = sourceGroup ? cloneModel(sourceGroup) : null;
  const sourceAnimations = entry?.animations ?? [];

  sheetTitleEl.textContent = tool.meta.name;
  sheetBodyEl.innerHTML = '';

  const ctx = {
    model: workingCopy,
    animations: sourceAnimations,
    capabilities: getCapabilities(sourceGroup, sourceAnimations),
    viewport: { camera, renderer, controls }, // for tools that need direct pointer/raycast access (texture-paint, bone dragging)
    preview: (group, animations = []) => {
      activePreviewGroup = group;
      displayGroup(group, animations);
    },
    showToast,
  };

  const apply = (finalGroup, label, newAnimations) => {
    activePreviewGroup = null;
    commitStep(finalGroup, label, newAnimations);
  };

  // buildPanel may optionally return a cleanup function (event listeners to
  // remove, viewport handles to dispose, camera controls to re-enable) -
  // storing it here means it reliably runs no matter HOW the panel closes,
  // rather than only when a specific button is clicked.
  activeCleanup = tool.buildPanel(sheetBodyEl, ctx, apply) || null;

  currentOpenToolId = tool.meta.id;
  panelEl.classList.remove('hidden');
  panelEl.setAttribute('aria-hidden', 'false');
  panelEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeSheetImmediate() {
  if (activeCleanup) { activeCleanup(); activeCleanup = null; }
  panelEl.classList.add('hidden');
  panelEl.setAttribute('aria-hidden', 'true');
  currentOpenToolId = null;
  controls.enabled = true; // defensive fallback even if a tool's own cleanup didn't run
  if (activePreviewGroup) {
    activePreviewGroup = null;
    const entry = currentEntry();
    displayGroup(entry?.group ?? null, entry?.animations ?? []);
  }
}
document.getElementById('sheet-close').addEventListener('click', closeSheetImmediate);

/* =========================================================================
   SAVE / EXPORT
   ========================================================================= */
function saveToDevice() {
  const entry = currentEntry();
  if (!entry?.group) return;
  const exporter = new GLTFExporter();
  exporter.parse(
    entry.group,
    (result) => {
      const blob = result instanceof ArrayBuffer
        ? new Blob([result], { type: 'model/gltf-binary' })
        : new Blob([JSON.stringify(result)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mesh-forge-${Date.now()}.glb`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast('Saved to your device');
    },
    (err) => showToast('Export failed: ' + (err?.message || err), true),
    { binary: true, animations: entry.animations || [] }
  );
}

/* =========================================================================
   ACTION BAR
   ========================================================================= */
document.getElementById('btn-undo').addEventListener('click', goBack);
document.getElementById('btn-save').addEventListener('click', saveToDevice);
document.getElementById('btn-reset').addEventListener('click', () => {
  if (history.length === 0) return;
  if (confirm('Clear all work and start over?')) resetAll();
});

/* =========================================================================
   BOOT
   ========================================================================= */
renderCurrent();
