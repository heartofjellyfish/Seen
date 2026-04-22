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
| `worldHalf` | `Boid` class | `(10, 4.5, 12)` | Half-extents of the invisible bounding box. Sized to stay inside the curtains (side at ±11, back at z=-16 world). |
| `maxSpeed` | `Boid` class | `0.12` | Units/frame (≈7 u/s @ 60fps). |
| `maxSteerForce` | `Boid` class | `0.0024` | Units/frame². **Must stay at ≈maxSpeed/50**; larger = jittery, smaller = floppy. |
| `neighborhoodRadius` | `Boid` class | `6.0` | Flocking radius. Dropped from 8.0 when the box shrank (volume halved → density doubled). Target 5–10 active neighbors. |
| Wall-avoid constant | `Boid.avoid()` | `0.02 / dsq` | Soft repulsion from each of 6 walls. Backed up by `clampToRoom()` hard stop. |
| Stage closed-curtain clamp | `Boid.clampToRoom()` | `z ≥ -7.75 local when in aperture` | Birds cannot cross the closed stage drape (world z=-10.75) within its physical rectangle (world x∈[-6.5, 6.5], y∈[1.5, 7.5]). Can go around: over the pelmet (y>7.5) or around the sides (\|x\|>6.5). |
| Goal multiplier | `Boid.goalMultiplier` | `0.0005` show / `0.002` hide | Per-Boid field. Flock sets it based on phase — weak pull during shows (flock lingers), strong pull during hides (flock commits to offscreen). |
| Separation cap | `Boid.separation()` | `maxSteerForce * 2.5` | Caps the anti-collision force. `4×` was too strong → birds spun in place. |
| Sampling rate | alignment/cohesion/separation | `60%` (`Math.random() > 0.4`) | Matches the reference pen. Reducing = cheaper but looser. |
| Hide dwell | picked in `Flock` | `12–18s` (random per visit) | How long the flock stays at an offscreen waypoint. |
| Show dwell | picked in `Flock` | `4–6s` (random per visit) | How long the flock lingers at an onscreen waypoint. |
| Hide-after-hide chance | `Flock` phase logic | `0.15` | From a hide, 15% chance to pick another hide (occasional extra-long absence) instead of the default 85% returning to a show. Show always transitions to hide. |

### Calibrated ratios — do not break these without deliberation

1. **maxSpeed : maxSteerForce = 50 : 1.** At this ratio turns look like bird physics. Raising steerForce makes the flock twitchy; lowering makes them overshoot goals.
2. **Goal multiplier ≈ maxSteerForce.** The reference pen uses `0.005` with `maxSpeed=5`, i.e. also 1/1000 of speed. At our `maxSpeed=0.12` that's `0.00012`; we use `0.0005` to accelerate waypoint transits without drowning out flocking.
3. **Active-neighbor count.** For radius `r`, neighborhood volume ≈ `(4/3)π r³`. Box volume = `8 · 10 · 4.5 · 12 = 4320`. Density = `NUM / 4320`. Active neighbors ≈ `(4/3)π r³ · density · 0.6` (the 0.6 is sampling rate). At `r=6`, `NUM=60` → ≈7.5, in the cohesion-produces-flocking range. Below ~3 the birds scatter; above ~15 they cluster into a blob.
4. **Hide ≫ show, but not by infinity.** Target 60–70% offscreen. **Math**: visible = show_dwell + leaving_transit (flock is still visible while transiting TO a hideout under the boosted goal pull — about 2s of the hide dwell). Hidden = hide_dwell − leaving_transit. With current values (12–18s hide, 4–6s show, 15% consecutive hide), the ≈20s cycle averages ~7s visible / ~13s hidden = **~35% visible**. Earlier tuning at 25–35s hide + 2–4s show + 35% consecutive hides dropped visibility to ~6% — almost entirely invisible — which was too much.

### Waypoint placement rules

Waypoints are split into two pools (`hideouts`, `shows`). Phase logic: show always → hide, but hide → show is only 65% (35% chance of another hide). Opening shows starts on `shows[0]` so the first few seconds have visible birds.

- **Hideouts must be reliably offscreen on both portrait and landscape.** Two safe zones:
  - `z > 7` (behind the camera at z=6) — robust for any aspect ratio.
  - `|x| ≥ 9.5` at `z=-3` — lateral half-width at distance 9 from camera at fov 55° is ≈ 7.5 landscape, narrower portrait. 9.5 clears the frustum with ~2m margin.
  - **All hideouts must also be inside the new smaller `worldHalf` box** (x ∈ ±10, y ∈ [0.5, 9.5], z ∈ [-15, 9] world). Previous hideouts at `|x|=12` or `z=10` were past the curtains — that's what was causing visible penetration.
- **Shows are CONTINUOUSLY-TRACKED CatmullRom curves.** Each route is a 5-point spline. Every frame, `goal = curve.getPoint(elapsed / duration)` — the goal slides smoothly along the curve over ~7s. The flock chases this moving target, trailing behind it like a tail. **This is the fix for the earlier "flock circles in a small area" problem**: with static sub-waypoints that changed every 1.5s + weak `goalMultiplier=0.0005`, the flock never reached any sub-point before the goal teleported elsewhere, so it just swirled in tug-of-war between nearby points. Continuous goal motion forces the flock to actually traverse the whole curve.
- **Routes pool (10 routes, deliberately spread across 5 motion categories)**. Earlier 8-route pool had 7 routes that all started "far-back" and ended "near-front-low" — different middles but same start+end zones — and the user (rightly) read them as the same trajectory played over and over. New categories force distinct screen-motion shapes:
  - **PURE LATERAL** (no depth change): `deep-cross-LR`, `deep-cross-RL`, `mid-cross-LR`
  - **PURE VERTICAL** (no x or z change): `dive-from-high`
  - **RECEDING into depth** (near → far): `rise-to-back`, `descend-to-back`
  - **APPROACHING the lens** (far → near): `near-charge` (just one — was 7 of 8 before)
  - **LOCAL ORBITS** (loops in one zone): `near-skim`, `side-orbit-L`, `high-arc`
- **Route control points must be inside the frustum AND inside the box** (`x ∈ [-10, 10]`, `y ∈ [0.5, 9.5]`, `z ∈ [-15, 9]` world) AND outside the stage aperture (`|x|<6.5, y∈[1.5, 7.5], z<-10.75`). Frustum guidelines by distance tier: NEAR (z=2-4): `|x|≤2, y∈[1.5, 3]`; MID (z=-5 to 0): `|x|≤5, y∈[2, 5]`; FAR (z=-10 to -7): `|x|≤7, y∈[3, 7]`. Using `z=-10` as the FAR limit keeps points out of the stage aperture automatically.
- **Curve speed vs flock maxSpeed**: each 7s-duration route is ≈20m long, giving curve speed ≈2.8 m/s. Flock maxSpeed is 7.2 m/s, so the flock CAN follow the moving goal. If curve were faster than the flock could chase, the flock would be left at the start.
- **`goalMultiplier` during show = 0.001** (not 0.0005 like a static goal would use). The moving curve-goal requires firmer pull to actually track it — 0.0005 left the flock permanently trailing the curve by ~10m. During hide `goalMultiplier = 0.002`.
- **Route bag** (Fisher-Yates) **+ bag-boundary protection**. Every 10 picks = full tour of all 10 routes, no repeats. Bag-boundary protection: when refilling, if the freshly-shuffled bag's first item equals the last picked from the previous bag, swap it with the next item — eliminates the 1/N chance of a back-to-back repeat across bag boundaries. At ~20s per cycle that's ≈3 min for a full tour.
- **Hideouts are still single-point, picked via side-alternating bag**. 85% chance of flipping side, 15% same side. Guarantees transit directions (flock exits left vs right) vary across cycles.

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
