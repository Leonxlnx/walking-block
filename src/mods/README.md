# Module contract (src/mods/*.js)

The scene is a colossal walking Soviet-style panel apartment block on mechanical legs, crossing a wet
foggy field at blue dusk. Target look: `refs/ref1.jpg … ref6.jpg` (photoreal, gritty, cinematic). LOOK AT THEM.

Each module is an ES module exporting `async function create(ctx)` that builds its objects and returns
`{ update(t, frame) }`. `main.js` loads modules listed in `?mods=` (default `env,building,chassis,legs,fx`)
inside try/catch, so a broken module never blocks the others.

## ctx
- `THREE` – three.js r170 namespace (addons importable via `three/addons/...`, e.g. `BufferGeometryUtils`).
- `scene` – world scene. `walker` – Group = the moving body (parent building/chassis/legs to it).
- `CFG` (src/config.js) – shared dimensions. `gait` (src/gait.js) – stateless walk math.
- `Mats`, `weathered(params, w)`, `applyWeather(mat, w)` (src/materials.js) – shared weathered PBR materials.
- `TEX` (src/textures.js) – `mulberry32(seed)`, `canvasTexture(w,h,draw,opts)`, `detailTexture()`, `tileFbm`.
- `rng(seed)` – seeded PRNG factory (same as TEX.mulberry32). `LOOK` – global look constants. `renderer`, `camera`.
- `frame` passed to update: `{ t, dt, frame, camera, pose:{x,y,z,roll,pitch,yaw}, shot }`.

## Frames & dimensions (meters, Y up, walker travels +X)
- `walker` origin = centre of the BASE of the apartment block. Rest height above ground: `CFG.RIDE_H` (18.5).
- Building: local x ∈ [-44, 44], z ∈ [-7.5, 7.5], y ≥ 0. 6 nominal floors × 3.0 m (sections may vary 5–7).
- Chassis (mechanical belly): local y ∈ [-4.5, 0], may overhang the building footprint by ~1–2 m.
- Hips: local `(CFG.LEG_X[k], CFG.HIP_Y, ±CFG.HIP_Z)` = x ∈ {-33,-11,11,33}, y=-2.6, z=±9.2. 4 legs per side.
- Thigh 12.5 m, shin 18 m. Knees bend up and outward (knee ends up around local y≈+3..+6, |z|≈19..21).
- Feet plant at world |z| = 18. Ankle joint is `CFG.ANKLE_H` = 1.9 m above the ground when planted.
- Ground is the plane y=0 (world). The walker moves ~2.9 m/s, so over the film it covers ~130 m in +X;
  anything on the ground must tile / follow the camera.

## Rules
1. **Determinism**: `update(t)` must be a pure function of `t` (frames are rendered offline in arbitrary
   order). No accumulated state, no `Math.random()`/`Date.now()` in update; use `rng(seed)` at build time.
2. **No swimming textures**: the walker moves, so never use world-space noise on walker parts. The shared
   weathering shader works in mesh-local space (after `instanceMatrix`) and needs NO UVs.
3. **HDR linear pipeline**: output goes through fog → DOF → bloom (threshold ≈0.75) → ACES → grade → grain.
   Lit warm windows / lamps should have radiance around `(2.4, 1.1, 0.32)` (bright core) down to
   `(0.9, 0.38, 0.1)` (dim) — use `MeshBasicMaterial({color: new THREE.Color(r,g,b)})` or emissive. They
   must read as tungsten ORANGE-AMBER, never white or lemon. Concrete is cool grey, metal pale and rusty.
4. **Lights**: do NOT add lights, except `chassis` may add ≤ 6 warm PointLights (castShadow=false,
   decay 2, sensible `distance`). Sky/key/hemi lights and the env map are owned by main.js.
5. **Shadows**: set `castShadow`/`receiveShadow` on significant geometry (one 4096 shadow map, soft key
   light from above). Tiny details should not cast.
6. **Performance (integrated Radeon 780M GPU!)**: use `InstancedMesh` and merged geometries
   (`BufferGeometryUtils.mergeGeometries`) aggressively. Budgets are per module and listed in your task.
   No textures above 2048². Dispose temp geometries. Building must finish in a few seconds.
7. **Only edit your own module file(s)**. Do not touch main.js, post.js, look.js, materials.js,
   textures.js, gait.js, config.js, shots.js, tools/. If you need something there, say so in your report.
   Extra materials/shaders/textures you need go inside your module.
8. Custom `ShaderMaterial`s are fine (fog is applied in post from depth, so just write correct depth;
   transparent things are not fogged properly — prefer alpha-tested/opaque geometry, or keep transparent
   things subtle). For Standard-material tweaks use `onBeforeCompile`.

## Materials (src/materials.js)
`Mats.concrete()`, `Mats.concreteDark()`, `Mats.paintedMetal({color})`, `Mats.steel()`, `Mats.rust()`,
`Mats.chrome()`, `Mats.rubber()`, `Mats.paint({color})`, `Mats.lamp({color,intensity})`.
Each returns a NEW MeshStandardMaterial with procedural grime/streaks/moss/chips/rust/wetness. Override
weathering with `{ w: { tex, grain, dirt, streak, moss, chip, rust, wet, bump, offset } }` (see W_DEFAULTS).
Streaks run along mesh-local -Y; noise is seeded by mesh-local position, so give identical parts a different
`w.offset` (THREE.Vector3) or bake different local positions if they must not look cloned.

## Iterating: the capture tool
```
node tools/shot.mjs --shots ref1,ref2 --t 2.0 --prefix mytag            # -> shots/mytag_ref1.png, ...
node tools/shot.mjs --shots ref2 --mods env,legs --prefix legsonly      # load only some modules
node tools/shot.mjs --cam "-60,3,40,0,20,0,45" --name close --prefix x  # free cam: pos xyz, target xyz, fov
node tools/shot.mjs --shots ref1,ref2,ref3,ref4,ref5,ref6 --prefix x --sheet   # + shots/x_sheet.jpg
node tools/shot.mjs --shots leg --ts 0,1.6,3.2,4.8 --prefix walk --sheet       # several times (animation)
```
- Camera coordinates are in the PATH FRAME (origin travels with the walker; building base centre is
  `[0,18.5,0]`, ground y=0). Presets live in src/shots.js: `ref1..ref6` mimic the reference images; also
  `facade, facadeClose, roof, leg, foot, knee, belly, end, back, grass`.
- Default 1280×720. Use a UNIQUE `--prefix` (your module name) so parallel workers don't overwrite files.
- The tool prints `MODULE ERRORS` / `CONSOLE` output: fix everything that comes from your module (errors
  from other modules may be someone else's work in progress — ignore them, or use `--mods`).
- Then `Read` the PNG/JPG and compare critically against `refs/refN.jpg`. Iterate many times.
- Run captures one at a time (shared integrated GPU), never leave servers/browsers running.

---
# ROUND 2 — detail wave (read this too)

The scene already works end to end and a 45 s film is cut from it. This round is about **density of believable
detail**: the owner wants every surface to hold up ~4× closer than it does now — more small parts, more grime
structure, more life, more atmosphere — while keeping the established look. You are polishing a finished thing,
not rebuilding it: keep what works, keep every existing API, and leave your module loading without errors at
every step (other workers capture the full scene while you work).

## What changed since round 1 (facts you must respect)
- Stance: `CFG.RIDE_H = 17.0`, `CFG.FOOT_Z = 23.0`; feet also splay along X (see `legInfo().homeX` in gait.js).
  Always read these from `CFG`/`gait`, never hard-code.
- Look (src/look.js, src/post.js — owned by the lead, do not edit): neutral-cool soft light (surfaces must keep
  their OWN colour; only the air is blue), darker belly, dense pale ground-mist band over the lowest ~3 m beyond
  ~40 m, AO pass (1.8 m radius), bloom threshold 0.6, coarse film grain, ACES. Capture with `--mb 4` for
  final-quality stills (sub-pixel jitter + motion blur).
- Colour targets measured from the references (sRGB, as rendered): lit concrete ≈ 94,97,104 (neutral warm grey,
  NOT blue); leg paint ≈ 90–150 grimy grey-beige with dark brown rust (≈ 90,55,35) on edges, rivets and drip
  streaks — never orange, no hazard stripes; window cores ≈ 242,193,130 amber (never lemon, never salmon);
  grass ≈ 43,52,28 dark olive with dry khaki tips; belly underside ≈ 31,32,29 with a few large warm lamps.
- A critic compared renders to the references. Its notes for your module are in your task prompt.

## The film (src/shots.js `TIMELINE`) — spend detail where the camera actually looks
1. `f_open` 0–5.5 s: lens 0.4 m above wet grass ~100 m ahead of the walker, rack focus from blades to the block.
2. `f_side` 5.5–11 s: long-lens side elevation of the whole block from ~150 m.
3. `f_hero` 11–16.5 s: low 3/4 hero from ~95 m (like ref2).
4. `f_foot` 16.5–20.5 s: worm's-eye 10 m from a foot that slams down (shin, ankle, claws, belly edge, cabins).
5. `f_belly` 20.5–26 s: on the ground looking straight up as the belly passes overhead.
6. `f_life` 26–31.5 s: drifting up the +Z facade from ~13 m (balconies, loggias, laundry, interiors).
7. `f_knee` 31.5–35.5 s: knee/thigh/hip of a leg from ~25 m while it lifts and slams.
8. `f_puddle` 35.5–40.5 s: 1.3 m above a puddle (world x≈130, z≈35), a foot plants 12 m behind it.
9. `f_away` 40.5–45 s: crane rising behind the walker as it leaves into the fog (roof visible).
Capture film shots by name, e.g. `node tools/shot.mjs --shots f_foot --ts 18.9 --mb 4 --prefix mytag`
(for film shots `--ts` is GLOBAL film time inside that shot's range), or the whole storyboard with
`node tools/shot.mjs --board --prefix mytag --w 960 --h 540`.

## Budgets for round 2 (integrated GPU; the final render is 1350 frames × several sub-frames)
Triangles per module (main pass): building ≤ 650k, legs ≤ 900k, chassis ≤ 450k, env ≤ 900k, fx/atmo ≤ 200k.
Prefer detail that costs nothing per frame: richer procedural textures/shader detail (≤ 2048² textures, a few
of them), normal/bump detail, vertex colours, decals, instancing. Keep draw calls roughly where they are (+30%).
Module build time must stay under ~10 s. Shader cost matters too: no heavy per-pixel loops on big surfaces.

## Working rules for this round
- Time-box: about 40 minutes of wall-clock work, then stop and report, leaving everything working.
- Capture at 960×540 while iterating (`--w 960 --h 540`), 1280×720 or `--mb 4` only for final checks. One
  capture at a time; several workers share one integrated GPU, so captures can take a while — be patient.
- Compare against `refs/ref1.jpg … ref6.jpg` again and again; judge at film-shot framing, not only close-ups.
- Do not touch files you do not own. Shared weathering shader lines in materials.js are string-patched by
  legs.js — the lead will not change them.
- Report (short): what you added, counts (tris/draw calls/build ms), anything risky, what you'd do next.
