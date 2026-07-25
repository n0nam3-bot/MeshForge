# Mesh Forge

A single-page, no-build-step web app that turns a 2D image into a 3D model, then
runs it through UV unwrapping, mesh repair, illumination baking, texture painting,
rigging, animation, jiggle physics, and slicing/defragging — entirely client-side,
entirely free, hostable on GitHub Pages, usable from a phone browser.

Every tool is its own standalone file under `tools/`. Nothing here needs npm,
a build step, or a server — it's plain HTML/CSS/JS loaded via `<script type="module">`,
with three.js pulled from a CDN through an import map. That's what makes it
possible to build by pasting files into GitHub's web editor from a phone.

## File layout (create these exact paths in your repo)

```
index.html
style.css
app.js
tools/importModel.js
tools/imageTo3D.js
tools/uvUnwrap.js
tools/meshRepair.js
tools/illumination.js
tools/texture.js
tools/rig.js
tools/animation.js
tools/jiggle.js
tools/slice.js
README.md
```

13 files total. `tools/` is the only subfolder.

## Uploading from your phone

**Easiest approach: create each file by pasting text, not by uploading.**
GitHub's mobile web editor handles this well and sidesteps every folder/picker
quirk of mobile file uploads:

1. On your repo's page, tap **Add file → Create new file**.
2. In the filename box, type the *full path* — e.g. typing `tools/rig.js` as
   the filename automatically creates the `tools` folder for you.
3. Paste that file's contents into the big text box below.
4. Scroll down, tap **Commit changes**.
5. Repeat for all 13 files.

If you'd rather upload the files as files (e.g. after downloading them from
this chat to your phone's Files app): use **Add file → Upload files** for the
3 root files first, then navigate *into* the `tools` folder (create it via the
paste method for just one file first, e.g. `tools/rig.js`) before uploading
the rest — GitHub's upload button drops files at whatever folder you're
currently browsing, and mobile browsers generally can't upload a whole folder
structure in one go.

## Turning on GitHub Pages

Once all 13 files are committed:

1. Repo → **Settings → Pages**.
2. Under "Build and deployment", set **Source** to "Deploy from a branch".
3. Branch: `main` (or whichever is your default), folder `/ (root)`.
4. Save. Your app will be live at `https://<your-username>.github.io/<repo-name>/`
   within a minute or two.

## Using the app

- **Start** section: either **Image → 3D** (upload a picture, it gets inflated
  into a rounded 3D shape) or **Upload 3D Model** (bring in an existing
  `.glb`/`.gltf`/`.obj` and skip straight to any tool).
- **Tools** section: the other 8 steps. Cards are grayed out until their
  prerequisite exists (e.g. Animation needs a skeleton first) — tap a grayed
  card to see why.
- Every tool opens as a bottom panel. Adjust its options, tap the primary
  button to preview, then **Apply** to commit it as the new current model.
- **Back** (bottom bar) steps back through your history one action at a time.
  Doing something new after stepping back discards whatever was ahead of it —
  standard undo-tree behavior.
- **Save** exports the current model as a `.glb` file to your device, at any
  point, with whatever geometry/rig/animation it currently has.
- **Reset** clears everything and starts over. So does a real page refresh —
  there's no auto-save between sessions, on purpose (per the original spec).

## How each tool actually works (and where it's simplified)

I researched existing free/open-source repos for each step first (linked
below for reference), then built compact from-scratch implementations of the
same underlying techniques rather than gluing those repos together directly —
several use Vue/React/WASM build pipelines that can't run as static
paste-and-go files, which was the hard constraint here. Everything below was
individually tested against hand-built and edge-case geometry (a concave
L-shape, an open cylinder with floating-point seam vertices, etc.) before
being written into these files — not just "looks right in one preview."

| Tool | Technique | Honest limitation |
|---|---|---|
| **Image → 3D** | Alpha/chroma-key masking → distance-transform height field → watertight extruded mesh with stitched rim (inspired by [harry7557558/img23d](https://github.com/harry7557558/img23d)) | Grid-based, not a true FEM solve — works best on clear, high-contrast subjects like logos or photos with the background removed |
| **UV Unwrap** | 6-direction box projection (inspired by [xatlas](https://github.com/repalash/xatlas-three)) | Can stretch on curved/organic surfaces; no atlas packing |
| **Add Mesh (Repair)** | Vertex welding (three.js's own `mergeVertices`), degenerate-triangle removal, boundary-loop hole filling | Hole filling uses simple fan triangulation — works well on small, roughly-planar holes, not complex ones |
| **Illumination** | Curvature/cavity-based AO approximation baked to vertex colors | Not true raycasted occlusion (skipped for mobile performance/dependency reasons) — a real approximation, not "AI lighting" |
| **Texture** | Direct canvas painting via viewport raycasting (inspired by [Aphene/texture-painter](https://github.com/Aphene/texture-painter)) | Brush tool only — no layers/undo within the canvas itself |
| **Rig (Bones)** | Bounding-box-scaled skeleton template (Humanoid or Simple) + inverse-square distance-to-nearest-bone-segment skin weights | Heuristic auto-rig, not ML-based — works best on roughly upright, humanoid-proportioned shapes |
| **Animation** | Procedural Idle/Walk/Wave clips built as real `THREE.AnimationClip`/keyframe data | Not motion-captured — simple sine-driven poses, but genuinely exports and plays back correctly elsewhere |
| **Jiggle** | Per-bone damped spring physics driven by the bone's own world-space velocity (inspired by [threeZboingZboing](https://github.com/WebAR-rocks/threeZboingZboing)) | Simplified single-axis-pair spring, not a full physically-based solver |
| **Slice / Defrag** | Connected-components split (union-find over position-keyed triangle adjacency) + arbitrary-plane cutting with cap-hole cleanup | Slicing a rigged model drops the rig (skin weights don't carry over automatically) |

GLB/GLTF is the common thread — every tool reads and writes through that
format, via three.js's official `GLTFLoader`/`GLTFExporter`. Baked animation
clips and any custom (non-default) bone rig travel with the exported file.

## If you want to level up a step later

The table above links the original researched repos each tool is inspired
by. If you outgrow the built-in version of a step, those are the natural
upgrades — but note most require adding a real build step (npm + a bundler),
which no longer fits "paste files into GitHub from a phone." Happy to help
you wire one in later if you want to go that route for a specific step.

## Known quirks worth knowing about

- "Back" is the in-app button, not your phone's hardware back button/gesture
  — the latter will just leave the page, same as on any other website.
- Undo/redo history and all model data live in memory only — nothing is
  saved automatically. Use **Save** whenever you want to keep a result.
  Refreshing the page always starts a clean session.
- Everything runs on your device's GPU/CPU. Very high-resolution Image→3D
  settings or very dense imported models may run slowly on older phones —
  the Detail slider defaults to a conservative value for this reason.
