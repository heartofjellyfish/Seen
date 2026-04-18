# Seen — project notes

Next.js 14 + React 18 + three.js 0.170 + @react-three/fiber. The hero scene is a Twin Peaks "Red Room" in [app/RedRoom.tsx](app/RedRoom.tsx). Read [app/RedRoom.tsx:12](app/RedRoom.tsx:12) for the top-down layout diagram before touching geometry.

---

## Controlling the background crow flock

The flock lives in [app/RedRoom.tsx:1795](app/RedRoom.tsx:1795) (`Flock` component) with the `Boid` class above it. Every knob listed here has been calibrated at least once by watching the result — if you change one, understand which other knob it was balanced against.

### Parameter catalog

All lengths are world units (≈ meters). Camera is at `(0, 1.65, 6)`, fov 55°, looking at `(0, 3, -13)`. Stage back curtain at `z = -22`. Venus at `(-3.7, 0, 0.4)`.

| Param | Location | Current | Role |
|---|---|---|---|
| `NUM` | Flock component | `60` | Bird count. Density = NUM / (worldHalf volume × 8). |
| `GROUP_POS` | Flock component | `(0, 5, -3)` | World origin of the flock group — all positions below are relative. |
| `worldHalf` | `Boid` class | `(14, 5, 16)` | Half-extents of the invisible bounding box. Walls bounce via `avoid()`. |
| `maxSpeed` | `Boid` class | `0.12` | Units/frame (≈7 u/s @ 60fps). |
| `maxSteerForce` | `Boid` class | `0.0024` | Units/frame². **Must stay at ≈maxSpeed/50**; larger = jittery, smaller = floppy. |
| `neighborhoodRadius` | `Boid` class | `8.0` | Flocking radius. Target 5–10 active neighbors (see formula below). |
| Wall-avoid constant | `Boid.avoid()` | `0.02 / dsq` | Repulsion from each of 6 walls. Was `0.06` — too strong, birds bounced off invisible walls early. |
| Goal multiplier | `Boid.doFlock()` | `0.0005` | Pull toward current waypoint. Same order as maxSteerForce so it doesn't dominate flocking. |
| Separation cap | `Boid.separation()` | `maxSteerForce * 2.5` | Caps the anti-collision force. `4×` was too strong → birds spun in place. |
| Sampling rate | alignment/cohesion/separation | `60%` (`Math.random() > 0.4`) | Matches the reference pen. Reducing = cheaper but looser. |
| Hideout dwell | `hideouts` entries | `18s` | How long the flock waits at an offscreen waypoint. |
| Show dwell | `shows` entries | `5s` | How long the flock lingers at an onscreen waypoint. |

### Calibrated ratios — do not break these without deliberation

1. **maxSpeed : maxSteerForce = 50 : 1.** At this ratio turns look like bird physics. Raising steerForce makes the flock twitchy; lowering makes them overshoot goals.
2. **Goal multiplier ≈ maxSteerForce.** The reference pen uses `0.005` with `maxSpeed=5`, i.e. also 1/1000 of speed. At our `maxSpeed=0.12` that's `0.00012`; we use `0.0005` to accelerate waypoint transits without drowning out flocking.
3. **Active-neighbor count.** For radius `r`, neighborhood volume ≈ `(4/3)π r³`. Box volume = `8 · 14 · 5 · 16 = 8960`. Density = `NUM / 8960`. Active neighbors ≈ `(4/3)π r³ · density · 0.6` (the 0.6 is sampling rate). At `r=8`, `NUM=60` → ≈5.7, which is where cohesion/alignment actually produce flocking. Below ~3 the birds scatter; above ~15 they cluster into a blob.
4. **Hide:show dwell ratio = 18:5.** Tune to shift visibility: more hide = rarer spectacle.

### Waypoint placement rules

Waypoints are split into two pools (`hideouts`, `shows`) and strictly alternate. The flock starts on `shows[0]` so the opening frame isn't empty.

- **Hideouts must be reliably offscreen on both portrait and landscape.** Two safe zones:
  - `z > 7` (behind the camera at z=6) — robust for any aspect ratio.
  - `|x| ≥ 12` at `z=-3` — lateral half-width at distance 9 from camera at fov 55° is ≈ 8.2 landscape, narrower portrait. 12 is well outside.
  - **Do not use** `(0, 9, -17)` or similar deep-stage-high points: at `z=-17`, vertical frame half-height ≈ 12, so `y=9` is still in frame. The frustum expands fast.
- **Shows must be inside the frustum.** The stage area: `y ∈ [2, 8]`, `x ∈ [-5, 5]`, `z ∈ [-16, 2]` is safe. Deep back corners (`|x|=4, z=-16`) are fine — the frustum at z=-16 is very wide.

### Known failure modes (root causes, not symptoms)

- **Flock collapses into a blob at eye level** → `neighborhoodRadius / worldHalf.y` was ≈87%. Every bird sees every other bird; cohesion wins globally and pulls everything toward the origin. Fix: keep radius < ~2× worldHalf.y and density within the active-neighbor target.
- **Birds spin in place** → separation force uncapped (or cap too high). Opposing separation vectors cancel in translation but dominate steering direction. Fix: cap ≈ `maxSteerForce × 2–3`.
- **Birds bounce off invisible walls early** → wall-avoid constant too high. Fix: drop toward `0.02 / dsq`.
- **Flock never leaves the goal** → goal multiplier too high. It overpowers flocking and every bird becomes a missile.
- **Birds in an idle/arms-out pose instead of flapping** → reading the wrong animation clip from a GLB, or `.reset().play()` on a one-shot clip that has a prep pose at t=0. Inspect the GLB's `animations` array first; don't guess the clip name.
- **Scene never visible** → `stage_hall` has `opacity: 0` in most debug modes. In preview_eval: `hall.style.setProperty('opacity', '1', 'important')`.

### Before tuning — checklist

The user has explicit feedback saved: if a complaint persists across 2+ rounds of parameter tweaks, stop and investigate structure before the next edit. For this flock, structural checks are:

1. Open the GLB (not applicable here — using procedural `BufferGeometry`).
2. Compute the active-neighbor count from the formula above.
3. Compare against the reference pen at [/tmp/pen_js.txt](/tmp/pen_js.txt) — original params: `_width=500, _height=500, _depth=200, _maxSpeed=5, _maxSteerForce=0.1, _neighborhoodRadius=200`, goal multiplier `0.005`. Our world is ≈40× smaller linearly, so speed/steer/radius all scale down proportionally.
4. Verify which waypoint is current — `phase.current` alternates `"show" | "hide"`.

---

## Dev server

`.claude/launch.json` defines `seen-dev` (port 3000). Use the `mcp__Claude_Preview__*` tools, not Bash, per the preview tool guidance. The `stage_hall` opacity trick above is needed to see the 3D scene in `debug-live` mode.
