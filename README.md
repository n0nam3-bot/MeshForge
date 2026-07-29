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
tools/_boneDrag.js
README.md
```

14 files total. `tools/` is the only subfolder. `_boneDrag.js` is a shared
helper used by Jiggle and Animation (bone picking/dragging in the viewport) -
it isn't a tool card itself, just a file the other two import from.

## Uploading from your phone

**Easiest approach: create each file by pasting text, not by uploading.**
GitHub's mobile web editor handles this well and sidesteps every folder/picker
quirk of mobile file uploads:

1. On your repo's page, tap **Add file → Create new file**.
2. In the filename box, type the *full path* — e.g. typing `tools/rig.js` as
   the filename automatically creates the `tools` folder for you.
3. Paste that file's contents into the big text box below.
4. Scroll down, tap **Commit changes**.
5. Repeat for all 14 files.

If you'd rather upload the files as files (e.g. after downloading them from
this chat to your phone's Files app): use **Add file → Upload files** for the
3 root files first, then navigate *into* the `tools` folder (create it via the
paste method for just one file first, e.g. `tools/rig.js`) before uploading
the rest — GitHub's upload button drops files at whatever folder you're
currently browsing, and mobile browsers generally can't upload a whole folder
structure in one go.

## Turning on GitHub Pages

Once all 14 files are committed:

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
- Every tool opens as a panel directly on the page, right below the viewer -
  not a popup or overlay, so you can see the model update live while you
  adjust settings. Tapping a different card swaps to that tool; tapping the
  same (open) card again closes it. Adjust options, tap the primary button
  to preview, then **Apply** to commit it as the new current model.
- While AI generation is running (Image → 3D), you'll see an elapsed-time
  counter and an animated progress bar - free-tier queue times vary, so
  "still working" is clearly distinguished from "stuck." A **Cancel** button
  lets you give up and try something else without waiting it out.
- **Back** (bottom bar) steps back through your history one action at a time.
  Doing something new after stepping back discards whatever was ahead of it —
  standard undo-tree behavior.
- **Save** exports the current model as a `.glb` file to your device, at any
  point, with whatever geometry/rig/animation it currently has.
- **Reset** clears everything and starts over. So does a real page refresh —
  there's no auto-save between sessions, on purpose (per the original spec).

## How each tool actually works (and where it's simplified)

| Tool | Technique | Honest limitation |
|---|---|---|
| **Image → 3D** | Real AI shape generation via [tencent/Hunyuan3D-2](https://huggingface.co/spaces/tencent/Hunyuan3D-2)'s `/shape_generation` endpoint (a genuine neural image-to-3D model), called live from your browser via Hugging Face's free public API - no server of your own, no install. Endpoint/parameters verified directly against the Space's own auto-generated API docs, not inferred from source. A Fast/Standard/High quality selector trades generation time for mesh detail (steps + octree resolution). A ~3-minute hard client-side timeout means a stuck/overloaded request fails clearly instead of hanging forever. Falls back to a local distance-transform "inflate" if you're offline, out of patience, or the free service is briefly busy/down. | This Space's texture synthesis is currently disabled on Hugging Face's hosted instance, so the AI path returns shape only (no auto-texture) - use the Texture tool afterward to paint it. The AI path also depends on a live third-party service - free, but can be slow, rate-limited, or occasionally down. The offline fallback is a simple relief-extrusion, not true 3D inference. |
| **UV Unwrap** | 6-direction box projection (inspired by [xatlas](https://github.com/repalash/xatlas-three)) | Can stretch on curved/organic surfaces; no atlas packing |
| **Add Mesh (Repair)** | Vertex welding (three.js's own `mergeVertices`), degenerate-triangle removal, boundary-loop hole filling | Hole filling uses simple fan triangulation - works well on small, roughly-planar holes, not complex ones |
| **Illumination** | Curvature/cavity-based AO approximation baked to vertex colors | Not true raycasted occlusion (skipped for mobile performance/dependency reasons) - a real approximation, not "AI lighting" |
| **Texture** | Direct canvas painting via viewport raycasting - drag directly on the model to paint (inspired by [Aphene/texture-painter](https://github.com/Aphene/texture-painter)) | Brush tool only - no layers/undo within the canvas itself. Orbit/zoom is disabled while this panel is open (painting needs the drag gesture) - close the panel to reposition the camera |
| **Rig (Bones)** | Bounding-box-scaled skeleton template (Humanoid or Simple) + inverse-square distance-to-nearest-bone-segment skin weights | Heuristic auto-rig, not ML-based - works best on roughly upright, humanoid-proportioned shapes |
| **Animation** | Quick procedural Idle/Walk/Wave presets, **or** drag any bone's handle directly in the viewport to pose it and capture keyframes - both build real `THREE.AnimationClip`/keyframe data | Custom posing captures full-body snapshots per keyframe (not per-bone tracks), and only rotation is posable by drag (position animation - like a walk cycle's hip bob - is preset-only) |
| **Jiggle** | Per-bone damped spring physics driven by the bone's own world-space velocity, **plus** drag any bone's handle to flick it and watch the spring react live (inspired by [threeZboingZboing](https://github.com/WebAR-rocks/threeZboingZboing)) | Simplified single-axis-pair spring, not a full physically-based solver. Orbit/zoom is disabled while this panel is open, same trade-off as Texture |
| **Slice / Defrag** | Connected-components split (union-find over position-keyed triangle adjacency) + arbitrary-plane cutting with cap-hole cleanup | Slicing a rigged model drops the rig (skin weights don't carry over automatically) |

GLB/GLTF is the common thread — every tool reads and writes through that
format, via three.js's official `GLTFLoader`/`GLTFExporter`. Baked animation
clips and any custom (non-default) bone rig travel with the exported file.

### Posing and testing directly on the model

Jiggle and Animation both put small cyan dots (bone handles) on the model in
the viewport - drag one to rotate that bone directly:

- **In Animation**, dragging poses the bone immediately (what you see is what
  gets captured). Set a time, tap **Capture Pose**, move things again, capture
  another keyframe, then **Build Clip** to interpolate between them.
- **In Jiggle**, dragging flicks the bone and hands off to the spring physics
  on release, so you can feel out stiffness/damping interactively instead of
  just guessing from slider numbers.
- Both panels disable camera orbiting while open, since the same drag
  gesture is doing double duty for posing. Close the panel to look around,
  then reopen it.

**Texture** works the same drag-on-the-model way for painting - tap **Texture**,
then draw directly on the viewport.

## If you want to level up a step later

The table above links the original researched repos each tool is inspired
by. If you outgrow the built-in version of a step, those are the natural
upgrades — but note most require adding a real build step (npm + a bundler),
which no longer fits "paste files into GitHub from a phone." Happy to help
you wire one in later if you want to go that route for a specific step.

## Known quirks worth knowing about

- "Back" is the in-app button, not your phone's hardware back button/gesture
  — the latter will just leave the page, same as on any other website.
- In Jiggle and Animation, dragging a bone's handle poses/tests it; dragging
  empty space orbits the camera; a two-finger pinch (or mouse wheel) zooms -
  all three work without fighting each other. Texture is different: every
  drag there is a paint stroke, so camera orbit/zoom is unavailable while
  that panel is open - close it to reposition the camera, then reopen.
- Image → 3D's AI option needs an internet connection and depends on a free
  public Hugging Face Space staying up - it usually will, but if it's ever
  slow, rate-limited, or briefly down, use the offline fallback in the same
  panel instead. It generates shape only right now (texture synthesis is
  disabled on this Space's current hosted instance) - use the Texture tool
  afterward to paint it. Higher quality settings take longer; if generation
  hasn't finished within ~3 minutes, it automatically times out with a
  clear error rather than hanging indefinitely.
- Undo/redo history and all model data live in memory only — nothing is
  saved automatically. Use **Save** whenever you want to keep a result.
  Refreshing the page always starts a clean session.
- Everything runs on your device's GPU/CPU. Very high-resolution Image→3D
  settings or very dense imported models may run slowly on older phones —
  the Detail slider defaults to a conservative value for this reason.
