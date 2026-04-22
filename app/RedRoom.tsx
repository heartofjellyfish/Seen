"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  PerspectiveCamera,
  Sparkles,
  Stats,
  useAnimations,
  useGLTF,
  useTexture,
} from "@react-three/drei";
import {
  ChromaticAberration,
  EffectComposer,
  Vignette,
} from "@react-three/postprocessing";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import * as THREE from "three";

// Must be called once before any RectAreaLight renders
RectAreaLightUniformsLib.init();

// ————— showtime countdown —————
// Every day at 12:00 America/Los_Angeles there is a 15-minute broadcast.
// The curtain backlight visualizes how close we are: dim cold red when
// far, warming up as the hour approaches, heartbeat pulse in the final
// 15 minutes, full golden blaze during the show window.

type ShowtimeState = {
  // 0 → 1 — overall "anticipation" ramp across the day
  anticipation: number;
  // 0 → 1 — heartbeat pulse intensity (~last 15 min + showtime)
  heartbeat: number;
  // Hz — heartbeat frequency (slow → fast)
  heartbeatHz: number;
  // 0 → 1 — 1.0 only during the 15-minute showtime window
  showtime: number;
  // 0 → 1 — fraction of 24h cycle for debugging / display
  phase: number;
};

// Seconds since LA midnight for the current wall-clock moment.
// Uses Intl to handle PDT/PST without manual offset math.
function laSecondsSinceMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")!.value);
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  const s = Number(parts.find((p) => p.type === "second")!.value);
  // en-US with hour12:false sometimes returns "24" for midnight
  return (h % 24) * 3600 + m * 60 + s;
}

const NOON_SEC = 12 * 3600;
const SHOW_DURATION_SEC = 15 * 60;
const DAY_SEC = 24 * 3600;

function computeShowtime(now = new Date()): ShowtimeState {
  const secs = laSecondsSinceMidnight(now);

  // Showtime window
  if (secs >= NOON_SEC && secs < NOON_SEC + SHOW_DURATION_SEC) {
    return {
      anticipation: 1,
      heartbeat: 1,
      heartbeatHz: 1.8, // fastest steady pulse during show
      showtime: 1,
      phase: secs / DAY_SEC,
    };
  }

  // Seconds until next noon (today's if still upcoming, else tomorrow's)
  const secsUntilShow =
    secs < NOON_SEC ? NOON_SEC - secs : NOON_SEC + DAY_SEC - secs;
  const minutes = secsUntilShow / 60;

  // Anticipation ramp — piecewise so the visual has clear stages
  let anticipation: number;
  if (minutes > 240) anticipation = 0.12;             // pre-dawn idle baseline
  else if (minutes > 60) anticipation = 0.12 + (240 - minutes) / 180 * 0.25; // 0.12→0.37
  else if (minutes > 15) anticipation = 0.37 + (60 - minutes) / 45 * 0.30;   // 0.37→0.67
  else if (minutes > 1)  anticipation = 0.67 + (15 - minutes) / 14 * 0.25;   // 0.67→0.92
  else                    anticipation = 0.92 + (1 - minutes) * 0.08;         // 0.92→1.00

  // Heartbeat starts subtly at 15 min, grows to full at 0
  let heartbeat = 0;
  let heartbeatHz = 0.6;
  if (minutes < 60 && minutes > 15) {
    heartbeat = (60 - minutes) / 45 * 0.35; // 0 → 0.35
    heartbeatHz = 0.55;
  } else if (minutes <= 15 && minutes > 1) {
    heartbeat = 0.35 + (15 - minutes) / 14 * 0.45; // 0.35 → 0.80
    heartbeatHz = 0.55 + (15 - minutes) / 14 * 0.75; // 0.55 → 1.30
  } else if (minutes <= 1) {
    heartbeat = 0.80 + (1 - minutes) * 0.20; // 0.80 → 1.00
    heartbeatHz = 1.30 + (1 - minutes) * 0.40; // 1.30 → 1.70
  }

  // Post-show fade — if we're in first 30s AFTER show end, ease back down
  if (secs >= NOON_SEC + SHOW_DURATION_SEC && secs < NOON_SEC + SHOW_DURATION_SEC + 30) {
    const fade = 1 - (secs - NOON_SEC - SHOW_DURATION_SEC) / 30;
    return {
      anticipation: anticipation + (1 - anticipation) * fade,
      heartbeat: heartbeat + (1 - heartbeat) * fade,
      heartbeatHz: heartbeatHz + (1.8 - heartbeatHz) * fade,
      showtime: 0,
      phase: secs / DAY_SEC,
    };
  }

  return {
    anticipation,
    heartbeat,
    heartbeatHz,
    showtime: 0,
    phase: secs / DAY_SEC,
  };
}

// Shared live state — ShowtimeDriver updates this each frame; consumers
// (CurtainBleedGlow, StageBackLight) read it instead of recomputing.
const showtimeLive: ShowtimeState = {
  anticipation: 0.12,
  heartbeat: 0,
  heartbeatHz: 0.6,
  showtime: 0,
  phase: 0,
};

function ShowtimeDriver() {
  useFrame(() => {
    const s = computeShowtime();
    showtimeLive.anticipation = s.anticipation;
    showtimeLive.heartbeat = s.heartbeat;
    showtimeLive.heartbeatHz = s.heartbeatHz;
    showtimeLive.showtime = s.showtime;
    showtimeLive.phase = s.phase;
  });
  return null;
}

// ————— scattering fog — atmospheric light scattering —————
// WebGL port of the Three.js WebGPU `custom_fog_scattering` example.
// Henyey-Greenstein phase function is injected into every opaque
// material's <fog_fragment> chunk via onBeforeCompile, so lights in
// the scene scatter visibly through the fog. No new geometry — this
// is pure light-transport math applied at the material level.

const SCATTER_LIGHT_COUNT = 6;

// Shared uniforms — all patched materials reference the same objects,
// so updating values here propagates to every shader.
const scatterUniforms = {
  uScatterLightPos: {
    value: Array.from({ length: SCATTER_LIGHT_COUNT }, () => new THREE.Vector3()),
  },
  uScatterLightColor: {
    value: Array.from({ length: SCATTER_LIGHT_COUNT }, () => new THREE.Color()),
  },
  uScatterLightStrength: {
    value: new Array(SCATTER_LIGHT_COUNT).fill(1),
  },
  uScatterFactor: { value: 1.0 },
  uAnisotropy: { value: 0.55 },
};

function patchMaterialForScattering(material: THREE.Material): void {
  const ud = material.userData as { scatterPatched?: boolean };
  if (ud.scatterPatched) return;
  ud.scatterPatched = true;

  const prev = material.onBeforeCompile?.bind(material);

  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);

    shader.uniforms.uScatterLightPos = scatterUniforms.uScatterLightPos;
    shader.uniforms.uScatterLightColor = scatterUniforms.uScatterLightColor;
    shader.uniforms.uScatterLightStrength = scatterUniforms.uScatterLightStrength;
    shader.uniforms.uScatterFactor = scatterUniforms.uScatterFactor;
    shader.uniforms.uAnisotropy = scatterUniforms.uAnisotropy;

    // Vertex: emit world-space position for fog scattering
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWorldPosFog;",
      )
      .replace(
        "#include <fog_vertex>",
        `#include <fog_vertex>
         vWorldPosFog = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    // Fragment: add uniforms + varying declarations next to fog pars
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <fog_pars_fragment>",
      `#include <fog_pars_fragment>
       varying vec3 vWorldPosFog;
       uniform vec3 uScatterLightPos[${SCATTER_LIGHT_COUNT}];
       uniform vec3 uScatterLightColor[${SCATTER_LIGHT_COUNT}];
       uniform float uScatterLightStrength[${SCATTER_LIGHT_COUNT}];
       uniform float uScatterFactor;
       uniform float uAnisotropy;`,
    );

    // Fragment: replace <fog_fragment> with scattering version.
    // Matches built-in fog math for fogFactor, then ADDS in-scattering
    // contribution to fogColor before compositing.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <fog_fragment>",
      /* glsl */ `
      #ifdef USE_FOG
        #ifdef FOG_EXP2
          float sfFogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        #else
          float sfFogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        #endif

        // View direction from fragment toward camera
        vec3 sfViewDir = normalize(cameraPosition - vWorldPosFog);
        vec3 sfScatter = vec3(0.0);

        for (int i = 0; i < ${SCATTER_LIGHT_COUNT}; i++) {
          vec3 sfToLight = uScatterLightPos[i] - vWorldPosFog;
          float sfDist = length(sfToLight);
          vec3 sfLightDir = sfToLight / max(sfDist, 1e-4);
          float sfCos = clamp(dot(sfViewDir, sfLightDir), -1.0, 1.0);

          // Henyey-Greenstein phase function
          float g = uAnisotropy;
          float g2 = g * g;
          float denom = 1.0 + g2 - 2.0 * g * sfCos;
          float phase = (1.0 - g2) / (4.0 * 3.14159265 * pow(max(denom, 1e-4), 1.5));

          // Distance attenuation (soft inverse-square)
          float atten = 1.0 / (1.0 + 0.08 * sfDist * sfDist);

          sfScatter += uScatterLightColor[i] * uScatterLightStrength[i] * phase * atten;
        }

        // Fog color + scattered light → compose onto frame
        vec3 sfFogOut = fogColor + sfScatter * uScatterFactor;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, sfFogOut, sfFogFactor);
      #endif
      `,
    );
  };

  material.needsUpdate = true;
}

// Component: configures FogExp2 + traverses scene, patching eligible
// materials. Updates light uniforms each frame to match curtain-bleed
// flicker so scattered halos breathe with the lights behind the curtain.
function ScatteringFog() {
  const scene = useThree((s) => s.scene);

  // Positions of the 6 curtain-bleed-glow patches (world space)
  const glowWorldPositions = useMemo(() => {
    const STAGE_Z = -13;
    const STAGE_H = 1.0;
    const CURTAIN_Z = STAGE_Z + 2.25 + 0.02;  // stageZ + stageD/2 + tiny offset
    const patches: Array<[number, number]> = [
      [-5.3, 0.4],
      [-3.2, 1.3],
      [-1.2, 0.3],
      [0.9, 1.1],
      [2.9, 0.7],
      [5.1, 1.5],
    ];
    return patches.map(([x, y]) => new THREE.Vector3(x, STAGE_H + y, CURTAIN_Z));
  }, []);

  // Initialize uniforms once
  useEffect(() => {
    glowWorldPositions.forEach((p, i) => {
      scatterUniforms.uScatterLightPos.value[i].copy(p);
      scatterUniforms.uScatterLightColor.value[i].setHex(0xff7638); // warm amber
    });
  }, [glowWorldPositions]);

  // Patch all eligible materials once on mount. All scene materials
  // are created synchronously during initial render, so a single pass
  // is enough — no need for a repeating interval.
  useEffect(() => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (m instanceof THREE.MeshBasicMaterial) continue;
        if (
          (m as THREE.Material).transparent &&
          (m as THREE.Material).blending === THREE.AdditiveBlending
        ) {
          continue;
        }
        patchMaterialForScattering(m);
      }
    });
  }, [scene]);

  // Flicker each scatter light in sync with curtain bleed aesthetic
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    for (let i = 0; i < SCATTER_LIGHT_COUNT; i++) {
      const seed = i * 1.73;
      scatterUniforms.uScatterLightStrength.value[i] =
        0.55 + Math.sin(t * 2.3 + seed) * 0.22 + Math.sin(t * 5.8 + seed * 0.3) * 0.10;
    }
  });

  return null;
}

/* ————————————————————————————————————————————————
   Red Room — a real 3D stage-in-a-curtained-room.

   Layout (top-down, camera looking in -z):

                  [back curtain z=-22]
                  ┌────────────────┐
                  │ [raised stage]  │
                  │ ┌──────────┐    │
   left curtain  ─┤ │ closed   │    ├─ right curtain
                  │ │ curtain  │    │
                  │ └──────────┘    │
                  │   chevron       │
                  │   floor         │
                  │                 │
   venus ·        │                 │
                  │                 │
                  └─────────────────┘
                         ▲
                       camera
   ———————————————————————————————————————————————— */

// ————— procedural chevron floor (seamless) —————

function makeChevronTexture(): THREE.CanvasTexture {
  const SIZE = 1024;
  const N_ZIGZAGS = 8;
  const N_STRIPES = 16;
  const STRIPE_H = SIZE / N_STRIPES;
  const PERIOD = SIZE / N_ZIGZAGS;
  const AMP = STRIPE_H * 0.55;

  const cream = [232, 213, 168];
  const wine = [74, 16, 16];

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.createImageData(SIZE, SIZE);
  const data = imgData.data;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const phase = (x / PERIOD) % 1;
      const tri = Math.abs(phase - 0.5) * 4 - 1;
      const yShifted = y + tri * AMP;
      const stripeIdx = Math.floor(yShifted / STRIPE_H);
      const parity = ((stripeIdx % 2) + 2) % 2;
      const c = parity === 0 ? wine : cream;
      const idx = (y * SIZE + x) * 4;
      data[idx] = c[0];
      data[idx + 1] = c[1];
      data[idx + 2] = c[2];
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

function Floor() {
  const tex = useMemo(() => makeChevronTexture(), []);
  tex.repeat.set(3, 5);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, -6]}
      receiveShadow
    >
      <planeGeometry args={[22, 36, 1, 1]} />
      <meshStandardMaterial map={tex} roughness={0.92} metalness={0.02} />
    </mesh>
  );
}

// ————— pleated velvet curtain panel —————
//
// A plane with vertical pleats baked into the geometry (cosine
// displacement along x, vertex normals recomputed). The material
// uses MeshPhysicalMaterial.sheen so you get the characteristic
// velvet back-scatter glow at grazing angles.

function CurtainPanel({
  width,
  height,
  position,
  rotation,
  pleatCount = 14,
  pleatDepth = 0.18,
  color = "#7a1212",
  sheenColor = "#d42828",
  emissiveColor = "#2a0303",
  emissiveStrength = 0.35,
  segments = 40,
  breathe = true,
}: {
  width: number;
  height: number;
  position: [number, number, number];
  rotation?: [number, number, number];
  pleatCount?: number;
  pleatDepth?: number;
  color?: string;
  sheenColor?: string;
  emissiveColor?: string;
  emissiveStrength?: number;
  segments?: number;
  breathe?: boolean;
}) {
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(width, height, segments, 6);
    const pos = geo.attributes.position;
    const pleatFreq = (pleatCount * Math.PI * 2) / width;
    // Also introduce a very slow large-scale undulation so the
    // curtain reads as hanging cloth, not a corrugated sheet.
    const bigFreq = (Math.PI * 2) / width;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // Pleats: main cosine; amplitude tapers near the top (hang
      // gather) and grows toward the bottom (free cloth)
      const topFalloff = THREE.MathUtils.smoothstep(y, height / 2, height / 2 - 0.8);
      const amp = pleatDepth * (0.55 + 0.45 * (1 - topFalloff));
      const z =
        Math.cos(x * pleatFreq) * amp +
        Math.cos(x * bigFreq + 0.6) * pleatDepth * 0.25;
      pos.setZ(i, z);
    }
    geo.computeVertexNormals();
    return geo;
  }, [width, height, pleatCount, pleatDepth, segments]);

  // ————— 4i breathing —————
  // Very slow scale along the curtain's local z (normal direction).
  // Each panel gets its own random phase so walls don't breathe in
  // sync. Amplitude is tiny (~2%) — you only notice it peripherally.
  const meshRef = useRef<THREE.Mesh>(null);
  const seed = useMemo(() => Math.random() * 100, []);
  useFrame(({ clock }) => {
    if (!breathe || !meshRef.current) return;
    const t = clock.elapsedTime + seed;
    // Bigger inhale — fundamental slow breath, a mid-freq swell,
    // and a faster tremor on top so the cloth looks like something
    // is pressing against it from behind.
    const s =
      1 +
      Math.sin(t * 0.38) * 0.055 +
      Math.sin(t * 0.71 + 1.3) * 0.032 +
      Math.sin(t * 1.7 + 0.4) * 0.018;
    meshRef.current.scale.z = s;
  });

  return (
    <mesh
      ref={meshRef}
      position={position}
      rotation={rotation}
      geometry={geometry}
      receiveShadow
         >
      <meshPhysicalMaterial
        color={color}
        roughness={0.92}
        metalness={0}
        sheen={1}
        sheenColor={sheenColor}
        sheenRoughness={0.3}
        emissive={emissiveColor}
        emissiveIntensity={emissiveStrength}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ————— Festoon — Austrian festoon valance —————
// Three cascading horizontal rows of scallops stacked so each row sags
// between vertical tie-points. Gold tassels hang at the bottom-row ties
// to mark the gathering. Baroque / ornate — the silhouette reads as a
// gathered Austrian festoon, not a flat strip.

// Procedural velvet pleat map: vertical bands of dark/light to simulate
// the shading of draped fabric folds. Used as `map` on the swag material
// so the surface has pleat-pattern tonal variation even without 3-D geom.
function makeVelvetPleatTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  // Base velvet tone
  ctx.fillStyle = "#ffffff"; // neutral, material.color multiplies against this
  ctx.fillRect(0, 0, W, H);
  // Vertical pleat bands — each pleat has a dark fold line + gradient
  const PLEATS = 22;
  for (let i = 0; i < PLEATS; i++) {
    const x = (i / PLEATS) * W;
    const w = W / PLEATS;
    // Per-pleat left-to-right gradient: lit face → fold (dark) → lit face
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0.00, "rgba(120, 120, 120, 1)"); // edge of pleat (shadowed)
    g.addColorStop(0.20, "rgba(235, 235, 235, 1)"); // peak of pleat (lit)
    g.addColorStop(0.50, "rgba(60,  60,  60,  1)"); // fold valley (deepest dark)
    g.addColorStop(0.80, "rgba(225, 225, 225, 1)"); // peak again
    g.addColorStop(1.00, "rgba(120, 120, 120, 1)"); // back to edge
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w, H);
  }
  // Overlay subtle vertical noise streaks so pleats aren't perfectly uniform
  for (let n = 0; n < 400; n++) {
    const nx = Math.random() * W;
    const ny = Math.random() * H;
    const nw = 2 + Math.random() * 3;
    const nh = 8 + Math.random() * 20;
    ctx.fillStyle = `rgba(0, 0, 0, ${0.05 + Math.random() * 0.08})`;
    ctx.fillRect(nx, ny, nw, nh);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// One horizontal row of scallops — straight top edge, scalloped bottom.
function makeAustrianRowGeometry({
  halfWidth,
  topHeight,
  scallopDepth,
  nScallops,
}: {
  halfWidth: number;
  topHeight: number;
  scallopDepth: number;
  nScallops: number;
}): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const topY = topHeight;
  const baseY = 0;
  const scallopW = (halfWidth * 2) / nScallops;

  shape.moveTo(-halfWidth, topY);
  shape.lineTo(halfWidth, topY);
  shape.lineTo(halfWidth, baseY);
  for (let i = 0; i < nScallops; i++) {
    const endX = halfWidth - scallopW * (i + 1);
    const ctrlX = halfWidth - scallopW * (i + 0.5);
    shape.quadraticCurveTo(ctrlX, baseY - scallopDepth, endX, baseY);
  }
  shape.lineTo(-halfWidth, topY);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 64);
}

function Festoon({
  width,
  position,
}: {
  width: number;
  position: [number, number, number];
}) {
  const halfW = width / 2;
  const N_SCALLOPS = 7;

  // Three cascading scallop rows — bottom has the biggest dip, top the
  // smallest. Each row sits higher and slightly closer to camera so
  // later rows render in front of earlier ones without z-fighting.
  const rows = useMemo(
    () => [
      { y: 0.00, depth: 0.55, topH: 0.18, z: 0.00 }, // bottom (largest)
      { y: 0.30, depth: 0.45, topH: 0.18, z: 0.02 }, // middle
      { y: 0.58, depth: 0.35, topH: 0.18, z: 0.04 }, // top (smallest)
    ],
    [],
  );

  const rowGeos = useMemo(
    () =>
      rows.map((r) =>
        makeAustrianRowGeometry({
          halfWidth: halfW,
          topHeight: r.topH,
          scallopDepth: r.depth,
          nScallops: N_SCALLOPS,
        }),
      ),
    [halfW, rows],
  );

  const pleatTex = useMemo(() => {
    const t = makeVelvetPleatTexture();
    t.repeat.set(4, 1); // finer pleat density across the width
    return t;
  }, []);

  // Tie-point X positions between scallops of the bottom row — 6
  // interior ties for 7 scallops. Tassels hang here.
  const scallopW = width / N_SCALLOPS;
  const tiePositions = useMemo(
    () =>
      Array.from(
        { length: N_SCALLOPS - 1 },
        (_, i) => -halfW + scallopW * (i + 1),
      ),
    [halfW, scallopW],
  );

  return (
    <group position={position}>
      {/* Three scallop rows, back to front. Emissive moderate so rows
          are visible but still respond to what little light exists. */}
      {rows.map((r, i) => (
        <mesh key={i} geometry={rowGeos[i]} position={[0, r.y, r.z]} >
          <meshStandardMaterial
            map={pleatTex}
            color="#6a1212"
            roughness={0.90}
            metalness={0}
            emissive="#2a0808"
            emissiveIntensity={0.35}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      {/* Gold bead + tassel at each tie-point of the bottom row —
          the "gathering" markers that give Austrian festoons their
          name. */}
      {tiePositions.map((x, i) => (
        <group
          key={`tassel-${i}`}
          position={[x, rows[0].y + 0.02, rows[0].z + 0.02]}
        >
          <mesh >
            <sphereGeometry args={[0.07, 12, 10]} />
            <meshStandardMaterial
              color="#8e6a24"
              roughness={0.45}
              metalness={0.8}
              emissive="#2a1a06"
              emissiveIntensity={0.28}
            />
          </mesh>
          <mesh position={[0, -0.14, 0]} >
            <coneGeometry args={[0.05, 0.22, 12]} />
            <meshStandardMaterial
              color="#7a5018"
              roughness={0.6}
              metalness={0.55}
              emissive="#1a1006"
              emissiveIntensity={0.22}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Walls() {
  return (
    <group>
      {/* Back wall — behind the stage */}
      <CurtainPanel
        width={22}
        height={9}
        position={[0, 4.5, -16]}
        pleatCount={16}
        pleatDepth={0.18}
      />
      {/* Left wall — denser pleats, darker/muted so it recedes behind stage */}
      <CurtainPanel
        width={28}
        height={9}
        position={[-11, 4.5, -6]}
        rotation={[0, Math.PI / 2, 0]}
        pleatCount={32}
        pleatDepth={0.264}
        segments={180}
        color="#5a0e0e"
        sheenColor="#8a1818"
      />
      {/* Right wall */}
      <CurtainPanel
        width={28}
        height={9}
        position={[11, 4.5, -6]}
        rotation={[0, -Math.PI / 2, 0]}
        pleatCount={32}
        pleatDepth={0.264}
        segments={180}
        color="#5a0e0e"
        sheenColor="#8a1818"
      />
      <VelvetCeiling />
    </group>
  );
}

function VelvetCeiling() {
  // Just a plain red velvet cloth above — flat, no pleats. Lets the
  // pleated walls + ceiling-chandelier light do the drama; the ceiling
  // is the quiet red "lid" closing the room.
  return (
    <mesh
      position={[0, 9, -6]}
      rotation={[Math.PI / 2, 0, 0]}
      receiveShadow
    >
      <planeGeometry args={[28, 28, 1, 1]} />
      <meshPhysicalMaterial
        color="#5a0f0f"
        roughness={0.95}
        metalness={0}
        sheen={1}
        sheenColor="#a01818"
        sheenRoughness={0.4}
        emissive="#1e0303"
        emissiveIntensity={0.3}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}


// ————— raised stage + its own proscenium curtains —————

function Stage() {
  const stageZ = -13;
  const stageW = 13;
  const stageD = 4.5;
  const stageH = 1.0;
  const curtainHeight = 6;
  const pelmetHeight = 0.8;

  return (
    <group position={[0, 0, stageZ]}>
      {/* Raised platform */}
      <mesh position={[0, stageH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[stageW, stageH, stageD]} />
        <meshStandardMaterial color="#1a0505" roughness={0.88} />
      </mesh>
      {/* Apron — a shallow extension of the deck in FRONT of the
          curtain line so the visible front row of the candle ring
          has a surface to stand on. Matches the deck material. */}
      <mesh
        position={[0, stageH / 2, stageD / 2 + 0.3]}
               receiveShadow
      >
        <boxGeometry args={[stageW, stageH, 0.6]} />
        <meshStandardMaterial color="#1a0505" roughness={0.88} />
      </mesh>
      {/* Stage floor trim — a thin brass strip at the APRON front */}
      <mesh position={[0, stageH + 0.03, stageD / 2 + 0.6]} >
        <boxGeometry args={[stageW, 0.06, 0.06]} />
        <meshStandardMaterial
          color="#8b6a34"
          metalness={0.75}
          roughness={0.45}
        />
      </mesh>

      {/* Pelmet above stage curtain (valance) */}
      <mesh
        position={[0, stageH + curtainHeight + pelmetHeight / 2, stageD / 2]}
             >
        <boxGeometry args={[stageW + 0.6, pelmetHeight, 0.35]} />
        <meshPhysicalMaterial
          color="#5a0f0f"
          roughness={0.95}
          metalness={0}
          sheen={1}
          sheenColor="#b02020"
          sheenRoughness={0.35}
          emissive="#1a0202"
          emissiveIntensity={0.3}
        />
      </mesh>

      {/* Festoon — scalloped velvet swag hanging below the pelmet.
          Adds the "draped classical theatre valance" silhouette over
          the top edge of the stage curtain. */}
      <Festoon
        width={stageW + 0.6}
        position={[0, stageH + curtainHeight + 0.1, stageD / 2 + 0.22]}
      />

      {/* Stage curtain — two pleated panels meeting in the middle */}
      <CurtainPanel
        width={stageW / 2 + 0.3}
        height={curtainHeight}
        position={[-stageW / 4 + 0.15, stageH + curtainHeight / 2, stageD / 2]}
        pleatCount={14}
        pleatDepth={0.15}
        color="#8a1818"
        sheenColor="#e03030"
        emissiveColor="#3c0606"
        emissiveStrength={0.55}
      />
      <CurtainPanel
        width={stageW / 2 + 0.3}
        height={curtainHeight}
        position={[stageW / 4 - 0.15, stageH + curtainHeight / 2, stageD / 2]}
        pleatCount={14}
        pleatDepth={0.15}
        color="#8a1818"
        sheenColor="#e03030"
        emissiveColor="#3c0606"
        emissiveStrength={0.55}
      />

      {/* Inner warm glow, as if something just behind the curtain is lit.
          Gently flickers so the backlight isn't static — the whole stage
          breathes. */}
      <StageBackLight stageH={stageH} />

      {/* Invisible flicker rim — the candle ring has been replaced
          by a bank of mist, but the warm point lights still flicker
          at their former positions so the illusion of 'something
          burning just behind the fog' survives. */}
      <StageCandleRing stageW={stageW} stageD={stageD} stageH={stageH} />

      <CurtainBleedGlow stageD={stageD} stageH={stageH} />

    </group>
  );
}

// Dedicated flickering pointLight behind the stage curtain — warmer +
// more animated than the original static light.
function StageBackLight({ stageH }: { stageH: number }) {
  const ref = useRef<THREE.PointLight>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    const breath = 0.85 + Math.sin(t * 0.42) * 0.12;
    const flick = Math.sin(t * 3.1) * 0.10 + Math.sin(t * 7.3 + 0.4) * 0.05;
    ref.current.intensity = 3.2 * Math.max(0, breath + flick);
  });
  return (
    <pointLight
      ref={ref}
      position={[0, stageH + 3, -0.3]}
      color="#e6b070"
      intensity={3.2}
      distance={7}
      decay={2}
    />
  );
}

// ————— parametric backlit curtain grid —————
// pointLights placed BEHIND the stage curtain + corresponding additive
// ————— candle ring on stage deck perimeter —————

function StageCandleRing({
  stageW,
  stageD,
  stageH,
}: {
  stageW: number;
  stageD: number;
  stageH: number;
}) {
  const candles = useMemo(() => {
    const FRONT_Z = stageD / 2 + 0.3; // on apron
    const BACK_Z = -stageD / 2 + 0.35;
    const LEFT_X = -stageW / 2 + 0.35;
    const RIGHT_X = stageW / 2 - 0.35;
    const out: Array<{
      x: number;
      z: number;
      h: number;
      seed: number;
      lit: boolean;
    }> = [];
    const N_FRONT = 3;   // perf: only 3 real flickering pointLights now
    const N_BACK = 7;
    const N_SIDE = 3;
    for (let i = 0; i < N_FRONT; i++) {
      const f = i / (N_FRONT - 1);
      out.push({
        x: THREE.MathUtils.lerp(-stageW / 2 + 0.7, stageW / 2 - 0.7, f),
        z: FRONT_Z,
        h: 0.26 + Math.random() * 0.14,
        seed: Math.random() * 10,
        lit: true, // visible → real pointLight
      });
    }
    for (let i = 0; i < N_BACK; i++) {
      const f = i / (N_BACK - 1);
      out.push({
        x: THREE.MathUtils.lerp(-stageW / 2 + 0.7, stageW / 2 - 0.7, f),
        z: BACK_Z,
        h: 0.26 + Math.random() * 0.14,
        seed: Math.random() * 10,
        lit: false, // hidden behind curtain, no GPU cost
      });
    }
    for (let i = 0; i < N_SIDE; i++) {
      const f = (i + 1) / (N_SIDE + 1);
      const z = THREE.MathUtils.lerp(BACK_Z, FRONT_Z, f);
      out.push({
        x: LEFT_X,
        z,
        h: 0.26 + Math.random() * 0.14,
        seed: Math.random() * 10,
        lit: false,
      });
      out.push({
        x: RIGHT_X,
        z,
        h: 0.26 + Math.random() * 0.14,
        seed: Math.random() * 10,
        lit: false,
      });
    }
    return out;
  }, [stageW, stageD]);

  const lightRefs = useRef<Array<THREE.PointLight | null>>(
    Array(candles.length).fill(null),
  );

  useFrame(({ clock }) => {
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!c.lit) continue;
      const t = clock.elapsedTime + c.seed;
      const flick =
        1 + Math.sin(t * 3.3) * 0.22 + Math.sin(t * 7.5 + 0.4) * 0.13;
      const l = lightRefs.current[i];
      if (l) l.intensity = 1.5 * flick;
    }
  });

  // Visible candle geometry was removed on purpose — a layer of
  // stage mist now sits in this area and hides where the candles
  // would have been. What remains is a rim of invisible flickering
  // point lights, so the flicker still crawls across the curtain,
  // apron, and fog. Unlit (back/side) entries are skipped entirely.
  return (
    <group>
      {candles.map((c, i) =>
        c.lit ? (
          <pointLight
            key={i}
            ref={(el) => {
              lightRefs.current[i] = el;
            }}
            position={[c.x, stageH + c.h + 0.1, c.z]}
            color="#f0b070"
            intensity={1.5}
            distance={5.5}
            decay={1.6}
          />
        ) : null,
      )}
    </group>
  );
}

// ————— curtain bleed-through glow —————
// Soft, warm, flickering patches painted on the FRONT of the stage
// curtain, simulating firelight from the candles behind it seeping
// through the velvet. These are the real "energy accumulating behind
// the curtain" cue; the actual back/side candles are occluded.

function makeRadialGlowTexture(): THREE.CanvasTexture {
  const SIZE = 128;
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(
    SIZE / 2,
    SIZE / 2,
    0,
    SIZE / 2,
    SIZE / 2,
    SIZE / 2,
  );
  g.addColorStop(0, "rgba(255, 220, 140, 1)");
  g.addColorStop(0.35, "rgba(240, 150, 70, 0.55)");
  g.addColorStop(1, "rgba(80, 30, 10, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function CurtainBleedGlow({
  stageD,
  stageH,
}: {
  stageD: number;
  stageH: number;
}) {
  const tex = useMemo(() => makeRadialGlowTexture(), []);
  const patches = useMemo(() => {
    // 16 patches covering the full curtain height (0 → ~5m) with
    // staggered x-positions so no large empty vertical column shows
    // through. Three temperature families (cherry / amber / gold)
    // layered across three height bands.
    const raw: Array<{
      x: number;
      y: number;
      size: number;
      color: string;
      peak: number;
    }> = [
      // Floor band (y 0.2–1.0) — dense, warm, candle-flame level.
      // Most of the light source reads as "things burning on the stage".
      { x: -5.5, y: 0.35, size: 1.3, color: "#ffb060", peak: 0.58 },
      { x: -4.0, y: 0.50, size: 1.4, color: "#ffd890", peak: 0.52 },
      { x: -2.7, y: 0.30, size: 1.3, color: "#ff8040", peak: 0.56 },
      { x: -1.3, y: 0.55, size: 1.4, color: "#ffd890", peak: 0.50 },
      { x:  0.0, y: 0.35, size: 1.3, color: "#ffb060", peak: 0.58 },
      { x:  1.3, y: 0.60, size: 1.4, color: "#ffd890", peak: 0.50 },
      { x:  2.7, y: 0.30, size: 1.3, color: "#ff8040", peak: 0.56 },
      { x:  4.0, y: 0.50, size: 1.4, color: "#ffb060", peak: 0.52 },
      { x:  5.5, y: 0.35, size: 1.3, color: "#ff8040", peak: 0.56 },
      // Low-mid band (y 1.2–2.0) — fewer, bigger halos diffusing upward
      { x: -3.0, y: 1.6, size: 2.4, color: "#ff5830", peak: 0.26 },
      { x:  3.2, y: 1.7, size: 2.4, color: "#ff5830", peak: 0.26 },
      { x:  0.0, y: 1.9, size: 2.6, color: "#ffa040", peak: 0.24 },
    ];
    return raw.map((p) => ({
      ...p,
      seed: Math.random() * 10,
      breathSeed: Math.random() * 6,
    }));
  }, []);
  const matRefs = useRef<Array<THREE.MeshBasicMaterial | null>>(
    Array(patches.length).fill(null),
  );
  useFrame(({ clock }) => {
    for (let i = 0; i < patches.length; i++) {
      const m = matRefs.current[i];
      if (!m) continue;
      const p = patches[i];
      const t = clock.elapsedTime;
      // Layered drive: slow breathing + medium wave + fast flicker
      const breath = 0.70 + Math.sin(t * 0.35 + p.breathSeed) * 0.25;
      const mid = Math.sin(t * 2.1 + p.seed) * 0.18;
      const fast = Math.sin(t * 6.3 + p.seed * 0.4) * 0.08;
      const drive = Math.max(0, breath + mid + fast);
      m.opacity = p.peak * drive;
    }
  });
  // Patches sit just in FRONT of the curtain plane at local z =
  // stageD/2 = curtain depth; +0.02 to avoid Z-fighting.
  const z = stageD / 2 + 0.02;
  return (
    <group>
      {patches.map((p, i) => (
        <mesh key={i} position={[p.x, stageH + p.y, z]}>
          <planeGeometry args={[p.size, p.size]} />
          <meshBasicMaterial
            ref={(el) => {
              matRefs.current[i] = el;
            }}
            map={tex}
            color={p.color}
            transparent
            opacity={0.0}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

// ————— Venus — decor in the left corner, grounded by a contact shadow —————

function makeContactShadowTexture(): THREE.CanvasTexture {
  const SIZE = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  // Harder, darker shadow near the centre — more grounded.
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, SIZE / 2);
  gradient.addColorStop(0, "rgba(0,0,0,0.95)");
  gradient.addColorStop(0.22, "rgba(0,0,0,0.82)");
  gradient.addColorStop(0.5, "rgba(0,0,0,0.4)");
  gradient.addColorStop(0.8, "rgba(0,0,0,0.08)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function Venus() {
  const tex = useTexture("/venus.png", (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
  }) as THREE.Texture;

  // Plane geometry with UVs remapped so the bottom 13% of the PNG
  // (the painted pedestal) is simply NOT SAMPLED. This lets the
  // material be a plain MeshStandardMaterial instead of a custom
  // shader — she now responds to all scene lights (hemisphere,
  // torchieres, sconces, altar spot) like everything else.
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(1.7, 2.4, 1, 1);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const v = uv.getY(i);
      // Map plane v∈[0,1] to texture v∈[0.13, 1.0] — skip painted pedestal
      uv.setY(i, 0.13 + v * 0.87);
    }
    uv.needsUpdate = true;
    return geo;
  }, []);

  const shadowTex = useMemo(() => makeContactShadowTexture(), []);

  // Layout:
  //   y=0 to 0.31       → darker wooden pedestal (de-emphasised)
  //   y=0.31 to 2.71    → Venus body plane (feet at bottom, head at top)
  //
  // Position: very close to the camera on the left, so she reads
  // as a clear near-ground figure. Rotated a touch toward centre.
  return (
    <group position={[-3.7, 0, 0.4]} rotation={[0, Math.PI / 7, 0]}>
      {/* Ground shadow — tighter now that the uplight is focused */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <planeGeometry args={[2.8, 1.6]} />
        <meshBasicMaterial
          map={shadowTex}
          transparent
          depthWrite={false}
          opacity={0.98}
        />
      </mesh>

      {/* Pedestal — darker wood, intentionally low-key so it doesn't
          compete with Venus for the eye. */}
      <mesh position={[0, 0.155, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.9, 0.31, 0.55]} />
        <meshStandardMaterial
          color="#2a1a0e"
          roughness={0.9}
          metalness={0.02}
        />
      </mesh>
      {/* Thin darker base line where pedestal meets floor */}
      <mesh position={[0, 0.005, 0]} >
        <boxGeometry args={[0.95, 0.01, 0.6]} />
        <meshStandardMaterial color="#1a0f06" roughness={0.95} />
      </mesh>

      {/* Invisible warm fill — no visible fixture, just soft light
          on her from slightly above and in front, falling off fast
          so it doesn't pollute the floor or pedestal. */}
      <pointLight
        position={[0.35, 2.4, 0.55]}
        color="#d4a878"
        intensity={2.6}
        distance={3.2}
        decay={2.2}
      />

      {/* Venus body. MeshStandardMaterial gives her full PBR
          lighting — every torchiere, sconce, altar spot, the new
          chest-aimed spot, and the hemisphere wash all affect her.
          Black-background keying is done via an onBeforeCompile
          hook that injects a luminance-based discard right after the
          map is sampled. */}
      <VenusBody geometry={geometry} tex={tex} />
    </group>
  );
}


function VenusBody({
  geometry,
  tex,
}: {
  geometry: THREE.BufferGeometry;
  tex: THREE.Texture;
}) {
  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      color: new THREE.Color("#e0ccb0"),
      emissive: new THREE.Color("#5a3018"),
      emissiveIntensity: 0.38,
      roughness: 0.68,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });

    mat.onBeforeCompile = (shader) => {
      // Inject luminance-based discard right after the map sample.
      // `diffuseColor` here is already color * mapTexel, so very-
      // dark pixels (the PNG's black background) get dropped.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `
          #include <map_fragment>
          vec4 venusTexel = texture2D(map, vMapUv);
          float venusLum = venusTexel.r + venusTexel.g + venusTexel.b - 0.06;
          if (venusLum < 0.15) discard;
        `
      );
    };

    return mat;
  }, [tex]);

  // No breathing — a stone statue should be stone.
  return <mesh position={[0, 1.51, 0]} geometry={geometry} material={material} castShadow />;
}

// ————————————————————————————————————————————————
// Old CRT TV — the "waiting room broadcast".
//
// Thematic opposite of Venus: classical sculpture vs. fame-machine.
// Every submitter gets pushed through the same 1-bit green-phosphor
// grammar. Warhol's "15 minutes" is the project's literal mechanic;
// this TV is the chyron that counts you down toward your turn.
//
// Placed at +x mirror of Venus (-3.7, 0, 0.4 → +3.7, 0, 0.4), rotated
// symmetrically. Reads state from the module-level `showtimeLive` so
// ON-AIR / LIVE modes fire during the noon LA window.
// ————————————————————————————————————————————————

type Submitter = {
  id: string;
  name: string;
  location: string;
  quote: string;
  avatarSeed: number;
};

// Placeholder queue. Real submissions will replace this — shape is
// { id, name, location, quote, avatarSeed }. Keep this order: [0] is
// currently ON AIR / next up.
const TV_QUEUE: Submitter[] = [
  { id: "p01", name: "JANE M. WHITFIELD",  location: "BROOKLYN, NY",    quote: "I built the thing nobody asked for.",       avatarSeed: 1 },
  { id: "p02", name: "MIGUEL ROSA",        location: "EL PASO, TX",     quote: "My mother called it a waste of time.",      avatarSeed: 2 },
  { id: "p03", name: "DEVON T. OKAFOR",    location: "DETROIT, MI",     quote: "I've been rehearsing this since 1994.",     avatarSeed: 3 },
  { id: "p04", name: "SARAH L. KIM",       location: "PORTLAND, OR",    quote: "Somebody has to go first.",                  avatarSeed: 4 },
  { id: "p05", name: "RAY HARLOW",         location: "ORLANDO, FL",     quote: "Don't tell my boss.",                        avatarSeed: 5 },
  { id: "p06", name: "ANNIE-MAE COLE",     location: "KANSAS CITY, MO", quote: "I didn't think anybody was watching.",       avatarSeed: 6 },
  { id: "p07", name: "TOMAS VALLEJO",      location: "TUCSON, AZ",      quote: "It only took twenty years.",                  avatarSeed: 7 },
  { id: "p08", name: "PATIENCE O'NEILL",   location: "BUTTE, MT",       quote: "Love you, Ma.",                               avatarSeed: 8 },
  { id: "p09", name: "HARRISON LEE",       location: "OAKLAND, CA",     quote: "I stopped apologizing.",                      avatarSeed: 9 },
  { id: "p10", name: "MARGIE STAHL",       location: "MILWAUKEE, WI",   quote: "Forty-one years in the same cubicle.",        avatarSeed: 10 },
];

// Seeded pseudo-random draw of an abstract head-and-shoulders portrait.
// Drawn in grayscale; the final CRT pass greens the whole frame.
function drawAvatar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  seed: number,
) {
  let s = (seed * 9301 + 49297) % 233280;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Studio backdrop gradient
  const bgTop = 60 + Math.floor(rnd() * 40);
  const bgBot = 25 + Math.floor(rnd() * 20);
  const bg = ctx.createLinearGradient(x, y, x, y + h);
  bg.addColorStop(0, `rgb(${bgTop},${bgTop},${bgTop})`);
  bg.addColorStop(1, `rgb(${bgBot},${bgBot},${bgBot})`);
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);

  // Key light wash
  const keyX = x + w * (0.25 + rnd() * 0.2);
  const keyY = y + h * 0.1;
  const key = ctx.createRadialGradient(keyX, keyY, 0, keyX, keyY, Math.max(w, h) * 0.9);
  key.addColorStop(0, "rgba(255,255,255,0.28)");
  key.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = key;
  ctx.fillRect(x, y, w, h);

  const cx = x + w / 2 + (rnd() - 0.5) * w * 0.04;

  // Shoulders (suit/coat)
  const suitTone = 30 + Math.floor(rnd() * 25);
  ctx.fillStyle = `rgb(${suitTone},${suitTone},${suitTone})`;
  ctx.beginPath();
  ctx.ellipse(cx, y + h * 1.08, w * 0.58, h * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  // Collar slash — hints at a shirt collar
  ctx.fillStyle = `rgb(${suitTone + 80},${suitTone + 80},${suitTone + 75})`;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.12, y + h * 0.78);
  ctx.lineTo(cx, y + h * 0.92);
  ctx.lineTo(cx + w * 0.12, y + h * 0.78);
  ctx.lineTo(cx + w * 0.05, y + h * 0.78);
  ctx.lineTo(cx, y + h * 0.86);
  ctx.lineTo(cx - w * 0.05, y + h * 0.78);
  ctx.closePath();
  ctx.fill();

  // Neck
  const skin = 140 + Math.floor(rnd() * 70);
  ctx.fillStyle = `rgb(${skin},${skin - 10},${skin - 25})`;
  ctx.fillRect(cx - w * 0.085, y + h * 0.58, w * 0.17, h * 0.22);

  // Head
  const headRx = w * (0.165 + rnd() * 0.035);
  const headRy = h * (0.215 + rnd() * 0.04);
  const headCy = y + h * 0.4;
  ctx.fillStyle = `rgb(${skin},${skin - 10},${skin - 25})`;
  ctx.beginPath();
  ctx.ellipse(cx, headCy, headRx, headRy, 0, 0, Math.PI * 2);
  ctx.fill();

  // Ear hint
  ctx.fillStyle = `rgb(${skin - 30},${skin - 40},${skin - 50})`;
  ctx.beginPath();
  ctx.ellipse(cx + headRx * 0.95, headCy + headRy * 0.05, headRx * 0.12, headRy * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx - headRx * 0.95, headCy + headRy * 0.05, headRx * 0.12, headRy * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair — one of several silhouettes
  const hairTone = 15 + Math.floor(rnd() * 45);
  ctx.fillStyle = `rgb(${hairTone},${Math.floor(hairTone * 0.85)},${Math.floor(hairTone * 0.7)})`;
  const hairStyle = Math.floor(rnd() * 5);
  ctx.beginPath();
  if (hairStyle === 0) {
    ctx.ellipse(cx, headCy - headRy * 0.45, headRx * 1.05, headRy * 0.6, 0, Math.PI, Math.PI * 2);
  } else if (hairStyle === 1) {
    ctx.ellipse(cx, headCy - headRy * 0.15, headRx * 1.18, headRy * 0.9, 0, Math.PI, Math.PI * 2);
  } else if (hairStyle === 2) {
    ctx.ellipse(cx, headCy - headRy * 0.55, headRx * 1.25, headRy * 0.55, 0, 0, Math.PI * 2);
  } else if (hairStyle === 3) {
    ctx.ellipse(cx, headCy - headRy * 0.7, headRx * 0.75, headRy * 0.3, 0, Math.PI, Math.PI * 2);
  } else {
    ctx.ellipse(cx - headRx * 0.2, headCy - headRy * 0.35, headRx * 1.05, headRy * 0.7, -0.2, Math.PI, Math.PI * 2);
  }
  ctx.fill();

  // Shadow under jaw
  ctx.fillStyle = `rgba(0,0,0,0.28)`;
  ctx.beginPath();
  ctx.ellipse(cx, headCy + headRy * 0.85, headRx * 0.85, headRy * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();

  // Features
  ctx.fillStyle = `rgba(15,15,15,0.85)`;
  // eyes
  ctx.fillRect(cx - headRx * 0.52, headCy - headRy * 0.12, headRx * 0.28, headRy * 0.09);
  ctx.fillRect(cx + headRx * 0.24, headCy - headRy * 0.12, headRx * 0.28, headRy * 0.09);
  // brow
  ctx.fillRect(cx - headRx * 0.55, headCy - headRy * 0.28, headRx * 0.35, headRy * 0.04);
  ctx.fillRect(cx + headRx * 0.20, headCy - headRy * 0.28, headRx * 0.35, headRy * 0.04);
  // mouth
  ctx.fillStyle = `rgba(40,15,15,0.7)`;
  ctx.fillRect(cx - headRx * 0.3, headCy + headRy * 0.38, headRx * 0.6, headRy * 0.06);
  // nose shadow
  ctx.fillStyle = `rgba(0,0,0,0.18)`;
  ctx.beginPath();
  ctx.ellipse(cx + headRx * 0.05, headCy + headRy * 0.15, headRx * 0.12, headRy * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// Draw grayscale horizontal-bar "test pattern" — stand-in for SMPTE
// bars on a B&W set. Used as a channel-change flash.
function drawTestPattern(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const tones = [230, 200, 170, 140, 110, 80, 50, 20];
  const colW = W / tones.length;
  for (let i = 0; i < tones.length; i++) {
    const v = tones[i];
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(i * colW, 0, colW + 1, H * 0.78);
  }
  // Circle + crosshair overlay
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(W / 2, H * 0.42, Math.min(W, H) * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H * 0.78);
  ctx.moveTo(0, H * 0.42); ctx.lineTo(W, H * 0.42);
  ctx.stroke();
  // Bottom strip
  ctx.fillStyle = "rgb(30,30,30)";
  ctx.fillRect(0, H * 0.78, W, H * 0.22);
  ctx.fillStyle = "rgb(220,220,220)";
  ctx.font = "bold 26px ui-monospace, 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.fillText("PLEASE STAND BY", W / 2, H * 0.91);
  ctx.font = "16px ui-monospace, monospace";
  ctx.fillText("CH 15 · WARHOL TV", W / 2, H * 0.97);
}

// Format seconds as HH:MM:SS (always positive, zero-padded)
function formatHMS(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(r)}`;
}

function formatMS(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(m)}:${p(r)}`;
}

// Seconds remaining until the next noon LA show.
function secondsUntilShow(): number {
  const secs = laSecondsSinceMidnight(new Date());
  return secs < NOON_SEC ? NOON_SEC - secs : NOON_SEC + DAY_SEC - secs;
}

// Pre-rendered overlay tiles — built once, reused every frame.
function makeCRTNoiseTile(size = 128): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.floor(Math.random() * 255);
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function makeScanlineTile(W: number, H: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  for (let y = 0; y < H; y += 3) {
    ctx.fillRect(0, y, W, 1);
  }
  return c;
}

// Mount / composition variants — URL ?tv=d|e|b|a|c|1|2|3|s
//   d = black A/V cart, mirror Venus (DEFAULT — institutional rolling stand)
//   e = 4-leg wooden easel stand
//   b = velvet altar
//   a = walnut credenza
//   c = hanging chains
//   1 = TV on armchair, 2 = side table, 3 = tall pedestal, s = loveseat
type TVMount = "e" | "s" | "a" | "b" | "c" | "d" | "1" | "2" | "3";
function getTVMount(): TVMount {
  if (typeof window === "undefined") return "d";
  const v = new URLSearchParams(window.location.search).get("tv");
  const valid: TVMount[] = ["e", "s", "a", "b", "c", "d", "1", "2", "3"];
  if ((valid as string[]).includes(v ?? "")) return v as TVMount;
  return "d";
}

function TVSet() {
  const mount = getTVMount();

  // Per-variant placement, scale and mount height. The numeric
  // variants (1/2/3) move the TV OUT of the aisle and relate it to
  // the audience chairs / Venus composition.
  const layout = (() => {
    switch (mount) {
      case "s":
        // TV sitting on the LONE oversize armchair at (2.0, -1).
        // Chair faces camera (rotY=π), cushions face +z. Big chair's
        // seat cushion top is at y≈0.56; TV lift 0.52 gives a slight
        // sink into the plush cushion.
        return { x: 2.0, z: -1, rotY: 0, scale: 0.92, lift: 0.52 };
      case "1":
        // TV perched on the front-right armchair seat (chair at 3.9,-3).
        return { x: 3.9, z: -3, rotY: -Math.PI / 7, scale: 0.62, lift: 0.42 };
      case "2":
        // TV on a small side table beside the same chair.
        return { x: 2.6, z: -3, rotY: -Math.PI / 9, scale: 0.65, lift: 0.52 };
      case "e":
        // Easel stand — TV as "art on display", mirroring Venus.
        // Easel legs converge at the TV base (~0.95m). TV screen
        // centre ends up at ~1.43m (eye level when standing).
        return { x: 3.7, z: 0.4, rotY: -Math.PI / 7, scale: 1.0, lift: 0.95 };
      case "3":
        // TV mirrored opposite Venus, lifted on a tall column
        return { x: 3.7, z: 0.4, rotY: -Math.PI / 7, scale: 1.0, lift: 1.48 };
      case "b":
        // Velvet altar — mirror Venus position. Altar ~52cm tall,
        // TV on top faces camera (mirror of Venus's slight inward tilt).
        return { x: 3.7, z: 0.4, rotY: -Math.PI / 7, scale: 1.0, lift: 0.55 };
      case "c":
        return { x: 0.9, z: 1.2, rotY: -Math.PI / 9, scale: 1.0, lift: 0.88 };
      case "d":
        // A/V cart — pulled in toward the centre aisle (x=1.5) and
        // scaled down a touch (1.05) so it doesn't block the right
        // chair pairs. Shorter cart (lift 0.60 vs 0.74) makes the
        // whole TV sit lower and read less dominant.
        return { x: 1.1, z: 1.8, rotY: -Math.PI / 8, scale: 1.05, lift: 0.60 };
      default: // a (credenza, still on carpet)
        return { x: 0.9, z: 1.2, rotY: -Math.PI / 9, scale: 1.0, lift: 0.54 };
    }
  })();
  const tvLift = layout.lift;
  const glowLightRef = useRef<THREE.PointLight | null>(null);
  // Throttle canvas redraw to ~30fps. Content changes slowly, so
  // full 60fps raster + texture re-upload is wasted work. Big CPU
  // savings without any visible quality loss.
  const lastDrawRef = useRef(0);

  // Canvas width chosen to match the screen plane's aspect ratio
  // (plane 0.74×0.45 → ratio 1.644; canvas 640×384 → ratio 1.667,
  // close enough that content maps without horizontal stretching).
  const W = 640;
  const H = 384;

  // Eager init — canvas + texture must exist before the first JSX render
  // so <meshBasicMaterial map={...}> receives a real texture.
  const { canvas, texture, noiseTile, scanlineTile } = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    return {
      canvas: c,
      texture: tex,
      noiseTile: makeCRTNoiseTile(128),
      scanlineTile: makeScanlineTile(W, H),
    };
  }, []);

  // Screen curvature: subtle convex plane — only ~12mm of bulge so
  // the edges don't recede and the content stays rectangular.
  // Sized so the bezel+screen fit INSIDE the cabinet face
  // (cabinet top y=0.97, speaker top y=0.43 → 54cm vertical window).
  const screenGeom = useMemo(() => {
    const SW = 0.74;
    const SH = 0.45;
    const g = new THREE.PlaneGeometry(SW, SH, 16, 12);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const nx = x / (SW / 2);
      const ny = y / (SH / 2);
      const r2 = nx * nx + ny * ny;
      pos.setZ(i, 0.012 * (1 - r2));
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, []);

  // Contact shadow texture, hoisted out of JSX to keep hook order stable.
  const shadowTex = useMemo(() => makeContactShadowTexture(), []);

  // Wood-grain procedural texture for the cabinet.
  const woodTex = useMemo(() => {
    const size = 256;
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d")!;
    // Walnut base
    ctx.fillStyle = "#3a1f10";
    ctx.fillRect(0, 0, size, size);
    // Grain streaks
    for (let i = 0; i < 80; i++) {
      const y = Math.random() * size;
      const alpha = 0.06 + Math.random() * 0.12;
      ctx.strokeStyle = `rgba(${90 + Math.random() * 40},${45 + Math.random() * 25},${20 + Math.random() * 15},${alpha})`;
      ctx.lineWidth = 0.5 + Math.random() * 1.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x < size; x += 8) {
        ctx.lineTo(x, y + Math.sin(x * 0.07 + i) * 2.5);
      }
      ctx.stroke();
    }
    // Darker knots
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = "rgba(15,8,3,0.55)";
      ctx.beginPath();
      ctx.ellipse(Math.random() * size, Math.random() * size, 6 + Math.random() * 6, 3 + Math.random() * 3, Math.random(), 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    // 30fps throttle — skip redraw if last draw was <33ms ago.
    if (t - lastDrawRef.current < 1 / 30) return;
    lastDrawRef.current = t;

    const ctx = canvas.getContext("2d")!;
    const secsToShow = secondsUntilShow();
    const onAir = showtimeLive.showtime > 0.5;

    // ——— Background (deep blue-black, not green)
    ctx.fillStyle = "#060a12";
    ctx.fillRect(0, 0, W, H);

    // ——— Pick screen mode
    // Waiting: station → next → lineup → next → test → loop
    // Showtime: on air (full photo)
    if (onAir) {
      drawOnAir(ctx, W, H, TV_QUEUE[0], Math.max(0, SHOW_DURATION_SEC - (laSecondsSinceMidnight(new Date()) - NOON_SEC)), t);
    } else {
      const script: Array<{ mode: string; dur: number }> = [
        { mode: "station", dur: 4.0 },
        { mode: "next", dur: 7.0 },
        { mode: "lineup", dur: 5.5 },
        { mode: "next2", dur: 7.0 },
        { mode: "test", dur: 1.4 },
      ];
      const total = script.reduce((a, b) => a + b.dur, 0);
      const tt = t % total;
      let acc = 0;
      let mode = script[0].mode;
      let phaseT = 0;
      for (const seg of script) {
        if (tt < acc + seg.dur) { mode = seg.mode; phaseT = (tt - acc) / seg.dur; break; }
        acc += seg.dur;
      }
      if (mode === "station") drawStationID(ctx, W, H, t);
      else if (mode === "next") drawNextUp(ctx, W, H, TV_QUEUE[0], secsToShow, t);
      else if (mode === "next2") drawNextUp(ctx, W, H, TV_QUEUE[1 % TV_QUEUE.length], secsToShow, t);
      else if (mode === "lineup") drawLineup(ctx, W, H, TV_QUEUE, secsToShow, t);
      else if (mode === "test") drawTestPattern(ctx, W, H);
      // channel-change wipe between segments
      const edge = 0.08;
      if (phaseT < edge) {
        const a = 1 - phaseT / edge;
        ctx.fillStyle = `rgba(0,0,0,${a * 0.85})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // ——— Bottom chyron (always, except during on-air which has own layout)
    if (!onAir) drawChyron(ctx, W, H, t, secsToShow);

    // ——— CRT post-process stack
    // Scanlines
    ctx.drawImage(scanlineTile, 0, 0);
    // Cool blue-white B&W-CRT tint via multiply (vs saturated green
    // phosphor). Matches the Lynch-living-room reference — slight
    // chemical cool cast, not "oscilloscope green".
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgb(180, 205, 230)";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    // Edge vignette — very soft; corners stay readable so content
    // reads as "fully on the screen", not squeezed into a central disk.
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.6, W / 2, H / 2, Math.max(W, H) * 0.85);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.30)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    // Persistent grain
    ctx.globalAlpha = 0.07;
    const n = noiseTile;
    const ox = Math.floor(Math.random() * 64);
    const oy = Math.floor(Math.random() * 64);
    for (let yy = -oy; yy < H; yy += n.height) {
      for (let xx = -ox; xx < W; xx += n.width) {
        ctx.drawImage(n, xx, yy);
      }
    }
    ctx.globalAlpha = 1;
    // Occasional static burst (~every 9s)
    const burstPhase = (t % 9) / 9;
    if (burstPhase < 0.04) {
      ctx.globalAlpha = 0.55;
      for (let yy = -oy; yy < H; yy += n.height) {
        for (let xx = -ox; xx < W; xx += n.width) {
          ctx.drawImage(n, xx, yy);
        }
      }
      ctx.globalAlpha = 1;
    }
    // Occasional V-hold roll (~every 14s). Previously used
    // getImageData/putImageData which is expensive (CPU→GPU round
    // trip per frame). Replaced with a simple dark band overlay +
    // thin highlight line — reads as "the picture jumped" without
    // moving pixel data.
    const rollPhase = (t % 14) / 14;
    if (rollPhase < 0.05) {
      const tearY = Math.floor((rollPhase / 0.05) * H);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, tearY - 12, W, 18);
      ctx.fillStyle = "rgba(220,235,255,0.35)";
      ctx.fillRect(0, tearY - 1, W, 2);
    }

    texture.needsUpdate = true;

    // Flicker the emissive glow light subtly with content brightness
    if (glowLightRef.current) {
      const flicker = 0.85 + Math.sin(t * 23) * 0.04 + Math.sin(t * 7.3) * 0.06;
      const bump = burstPhase < 0.04 ? 1.35 : 1;
      glowLightRef.current.intensity = 0.9 * flicker * bump;
    }

    // (Antenna jitter removed — antennas no longer rendered.)
  });

  return (
    <group
      position={[layout.x, 0, layout.z]}
      rotation={[0, layout.rotY, 0]}
    >
      {/* Ground shadow (fade out for hanging / elevated variants).
          Scaled so the shadow area tracks the TV footprint. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <planeGeometry args={[2.2 * layout.scale, 1.4 * layout.scale]} />
        <meshBasicMaterial
          map={shadowTex}
          transparent
          depthWrite={false}
          opacity={mount === "c" ? 0.55 : mount === "1" || mount === "3" ? 0.4 : 0.9}
        />
      </mesh>

      {/* ——— Mount variants (at world scale, NOT affected by TV scale) ——— */}
      {mount === "a" && <MountCredenza woodTex={woodTex} />}
      {mount === "b" && <MountAltar />}
      {mount === "c" && <MountChains tvLift={tvLift} />}
      {mount === "d" && <MountCart tvLift={tvLift} />}
      {mount === "e" && <MountEasel woodTex={woodTex} tvLift={tvLift} />}
      {mount === "2" && <MountSideTable woodTex={woodTex} tvLift={tvLift} />}
      {mount === "3" && <MountTallPedestal woodTex={woodTex} tvLift={tvLift} />}
      {/* variant 1 = no mount, TV rides on the existing armchair seat */}

      {/* ——— TV body: lifted by world-space tvLift, then scaled.
           Keeping scale INSIDE the lift-group means tvLift is always
           in real meters regardless of the variant's scale factor. */}
      <group position={[0, tvLift, 0]} scale={layout.scale}>
        {/* Four splayed wooden legs — skipped when hanging (c). */}
        {mount !== "c" &&
          [
            [-0.45, 0, -0.22],
            [0.45, 0, -0.22],
            [-0.45, 0, 0.22],
            [0.45, 0, 0.22],
          ].map(([x, , z], i) => (
            <mesh key={i} position={[x as number, 0.09, z as number]} rotation={[0, 0, ((x as number) > 0 ? -1 : 1) * 0.08]} >
              <cylinderGeometry args={[0.018, 0.028, 0.18, 10]} />
              <meshStandardMaterial color="#1c0e06" roughness={0.85} metalness={0.05} />
            </mesh>
          ))}

        {/* Main cabinet body (walnut console) */}
        <mesh position={[0, 0.58, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.08, 0.78, 0.48]} />
          <meshStandardMaterial map={woodTex} color="#5a3018" roughness={0.55} metalness={0.08} />
        </mesh>

        {/* Darker top trim */}
        <mesh position={[0, 0.99, 0]} >
          <boxGeometry args={[1.1, 0.04, 0.5]} />
          <meshStandardMaterial color="#2a140a" roughness={0.7} />
        </mesh>

        {/* Black screen bezel */}
        <mesh position={[0, 0.70, 0.241]}>
          <planeGeometry args={[0.78, 0.49]} />
          <meshStandardMaterial color="#0b0603" roughness={0.9} metalness={0.1} />
        </mesh>

        {/* CRT glass */}
        <mesh position={[0, 0.70, 0.247]} geometry={screenGeom}>
          <meshBasicMaterial map={texture} toneMapped={false} />
        </mesh>

        {/* Speaker grille panel */}
        <mesh position={[0, 0.32, 0.241]}>
          <planeGeometry args={[0.88, 0.22]} />
          <meshStandardMaterial color="#1a1008" roughness={0.95} metalness={0} />
        </mesh>
        {Array.from({ length: 9 }).map((_, i) => (
          <mesh key={i} position={[0, 0.32 - 0.09 + i * 0.022, 0.2415]}>
            <planeGeometry args={[0.86, 0.004]} />
            <meshBasicMaterial color="#352414" />
          </mesh>
        ))}

        {/* Brand plate */}
        <mesh position={[-0.34, 0.18, 0.2412]}>
          <planeGeometry args={[0.14, 0.025]} />
          <meshStandardMaterial color="#a08448" roughness={0.4} metalness={0.6} />
        </mesh>

        {/* Two knobs */}
        <mesh position={[0.38, 0.34, 0.246]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.028, 0.032, 0.022, 16]} />
          <meshStandardMaterial color="#d3bf7a" roughness={0.35} metalness={0.75} />
        </mesh>
        <mesh position={[0.38, 0.25, 0.246]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.022, 0.025, 0.018, 16]} />
          <meshStandardMaterial color="#d3bf7a" roughness={0.35} metalness={0.75} />
        </mesh>

        {/* Channel indicator LED */}
        <mesh position={[0.38, 0.42, 0.247]}>
          <circleGeometry args={[0.006, 12]} />
          <meshBasicMaterial color="#ffb040" toneMapped={false} />
        </mesh>

        {/* Antennas removed — TV reads cleaner as "broadcast monitor"
            without the bunny ears. */}

        {/* Screen glow point light */}
        <pointLight
          ref={glowLightRef}
          position={[0, 0.70, 0.8]}
          color="#b8d0f0"
          intensity={1.35}
          distance={4}
          decay={2.1}
        />
      </group>
    </group>
  );
}

// ————— Mount variants —————

// Variant A: Walnut credenza — low cabinet matching the TV wood.
function MountCredenza({ woodTex }: { woodTex: THREE.Texture }) {
  return (
    <group>
      {/* Top surface (TV sits on this) */}
      <mesh position={[0, 0.52, 0]}  receiveShadow>
        <boxGeometry args={[1.22, 0.04, 0.62]} />
        <meshStandardMaterial map={woodTex} color="#4a2814" roughness={0.55} metalness={0.08} />
      </mesh>
      {/* Body */}
      <mesh position={[0, 0.28, 0]}  receiveShadow>
        <boxGeometry args={[1.14, 0.48, 0.56]} />
        <meshStandardMaterial map={woodTex} color="#4a2814" roughness={0.55} metalness={0.08} />
      </mesh>
      {/* Scalloped apron detail — thin strip below body */}
      <mesh position={[0, 0.035, 0.281]}>
        <planeGeometry args={[1.1, 0.06]} />
        <meshStandardMaterial color="#2a140a" roughness={0.85} />
      </mesh>
      {/* Four tapered legs */}
      {[
        [-0.5, -0.24],
        [0.5, -0.24],
        [-0.5, 0.24],
        [0.5, 0.24],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.04, z]} >
          <cylinderGeometry args={[0.018, 0.024, 0.08, 10]} />
          <meshStandardMaterial color="#1c0e06" roughness={0.85} />
        </mesh>
      ))}
      {/* Two brass pulls on the front, at cabinet mid-height */}
      <mesh position={[-0.22, 0.30, 0.281]}>
        <sphereGeometry args={[0.014, 12, 10]} />
        <meshStandardMaterial color="#caa860" metalness={0.85} roughness={0.3} />
      </mesh>
      <mesh position={[0.22, 0.30, 0.281]}>
        <sphereGeometry args={[0.014, 12, 10]} />
        <meshStandardMaterial color="#caa860" metalness={0.85} roughness={0.3} />
      </mesh>
      {/* Faint door seam down the middle */}
      <mesh position={[0, 0.30, 0.2812]}>
        <planeGeometry args={[0.004, 0.42]} />
        <meshBasicMaterial color="#1a0a04" />
      </mesh>
    </group>
  );
}

// Variant B: Velvet-draped altar — mirrors Venus's pedestal in
// material language (crimson velvet + gilt trim).
function MountAltar() {
  return (
    <group>
      {/* Velvet body */}
      <mesh position={[0, 0.27, 0]}  receiveShadow>
        <boxGeometry args={[1.04, 0.52, 0.60]} />
        <meshPhysicalMaterial
          color="#4a0812"
          roughness={0.96}
          metalness={0}
          sheen={1}
          sheenColor="#a01822"
          sheenRoughness={0.35}
          emissive="#1a0208"
          emissiveIntensity={0.15}
        />
      </mesh>
      {/* Gilt top trim */}
      <mesh position={[0, 0.535, 0]}>
        <boxGeometry args={[1.06, 0.015, 0.62]} />
        <meshStandardMaterial color="#b8934a" metalness={0.75} roughness={0.35} />
      </mesh>
      {/* Gilt bottom trim */}
      <mesh position={[0, 0.01, 0]}>
        <boxGeometry args={[1.06, 0.015, 0.62]} />
        <meshStandardMaterial color="#b8934a" metalness={0.75} roughness={0.35} />
      </mesh>
      {/* Two gold tassels dangling from front corners */}
      {[-0.48, 0.48].map((x, i) => (
        <group key={i} position={[x, 0, 0.31]}>
          <mesh position={[0, 0.12, 0]}>
            <cylinderGeometry args={[0.004, 0.004, 0.18, 6]} />
            <meshStandardMaterial color="#b8934a" metalness={0.4} roughness={0.55} />
          </mesh>
          <mesh position={[0, 0.04, 0]}>
            <coneGeometry args={[0.024, 0.07, 10]} />
            <meshStandardMaterial color="#d0a858" metalness={0.55} roughness={0.45} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// Variant C: Suspended by two dark iron "chains" (simplified as thin
// cylinders) going up into the unlit ceiling above.
function MountChains({ tvLift }: { tvLift: number }) {
  // TV body top (in TV-local coords after lift) is at ~y=1.0. World
  // top after lift = tvLift + 1.0. Chains reach up to y=5.0.
  const TOP = 5.0;
  const CHAIN_TOP_Y = tvLift + 1.0;
  const chainLen = TOP - CHAIN_TOP_Y;
  const chainCenterY = CHAIN_TOP_Y + chainLen / 2;
  return (
    <group>
      {[-0.32, 0.32].map((x, i) => (
        <mesh key={i} position={[x, chainCenterY, 0]}>
          <cylinderGeometry args={[0.012, 0.012, chainLen, 8]} />
          <meshStandardMaterial color="#1a120a" metalness={0.85} roughness={0.45} />
        </mesh>
      ))}
      {/* Eye-hook mounts on top of the TV cabinet */}
      {[-0.32, 0.32].map((x, i) => (
        <mesh key={i} position={[x, tvLift + 1.02, 0]}>
          <torusGeometry args={[0.025, 0.005, 8, 16]} />
          <meshStandardMaterial color="#1a120a" metalness={0.8} roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

// Variant E: Easel-style 4-leg stand — like a FITUEYES art easel
// that elevates a painting. The TV sits as "art on display" paralleling
// Venus on her pedestal.
function MountEasel({ woodTex, tvLift }: { woodTex: THREE.Texture; tvLift: number }) {
  // Leg tops meet just under the TV base. tvLift = cabinet-bottom y.
  // The central hub sits at hubY (just below tvLift). Feet splay to
  // footR radius at floor level.
  const hubY = tvLift - 0.02; // hub right under TV
  const footR = 0.42; // radius of splay at floor
  const hubR = 0.06; // narrow at the top where legs meet
  // 4 legs going from (±footR, 0, ±footR) up to (0, hubY, 0).
  const legPositions: Array<[number, number]> = [
    [-footR, -footR * 0.75],
    [footR, -footR * 0.75],
    [-footR, footR * 0.75],
    [footR, footR * 0.75],
  ];
  return (
    <group>
      {/* 4 tapered legs (dark walnut). Each leg is a long box whose
          top end is near the hub and bottom end is at the foot. */}
      {legPositions.map(([fx, fz], i) => {
        const dx = fx;
        const dz = fz;
        const len = Math.sqrt(dx * dx + hubY * hubY + dz * dz);
        // Midpoint between hub and foot
        const mx = dx / 2;
        const mz = dz / 2;
        const my = hubY / 2;
        // Orientation — rotate a vertical box so its axis points from foot to hub
        // Easiest: use a Group with lookAt-like rotation.
        const phi = Math.atan2(dx, dz); // rotation around y
        const theta = Math.atan2(Math.sqrt(dx * dx + dz * dz), hubY); // tilt
        return (
          <group key={i} position={[mx, my, mz]} rotation={[0, phi, 0]}>
            <mesh rotation={[theta, 0, 0]} >
              {/* box: small square cross-section, length = distance */}
              <boxGeometry args={[0.035, 0.035, len]} />
              <meshStandardMaterial map={woodTex} color="#3a1f10" roughness={0.55} metalness={0.12} />
            </mesh>
          </group>
        );
      })}
      {/* Tiny foot pads (rubber-ish) at each leg base */}
      {legPositions.map(([fx, fz], i) => (
        <mesh key={i} position={[fx, 0.012, fz]}>
          <cylinderGeometry args={[0.022, 0.026, 0.024, 10]} />
          <meshStandardMaterial color="#14120e" roughness={0.9} />
        </mesh>
      ))}
      {/* Central hub — a short matte-black block at the top where the
          legs meet, like the FITUEYES junction block in the reference. */}
      <mesh position={[0, hubY, 0]} >
        <boxGeometry args={[hubR * 2.2, 0.08, hubR * 2.0]} />
        <meshStandardMaterial color="#161412" roughness={0.45} metalness={0.55} />
      </mesh>
      {/* Short vertical neck from the hub up to the TV back */}
      <mesh position={[0, hubY + 0.06, 0]}>
        <cylinderGeometry args={[0.014, 0.014, 0.08, 8]} />
        <meshStandardMaterial color="#161412" roughness={0.5} metalness={0.55} />
      </mesh>
    </group>
  );
}

// Variant 2: Small wood side table beside an armchair.
function MountSideTable({ woodTex, tvLift }: { woodTex: THREE.Texture; tvLift: number }) {
  const tableTop = tvLift;
  return (
    <group>
      {/* Top */}
      <mesh position={[0, tableTop - 0.015, 0]}  receiveShadow>
        <cylinderGeometry args={[0.3, 0.3, 0.03, 24]} />
        <meshStandardMaterial map={woodTex} color="#4a2814" roughness={0.55} metalness={0.08} />
      </mesh>
      {/* Central column */}
      <mesh position={[0, tableTop / 2, 0]} >
        <cylinderGeometry args={[0.04, 0.045, tableTop - 0.03, 12]} />
        <meshStandardMaterial map={woodTex} color="#3a1f10" roughness={0.6} metalness={0.05} />
      </mesh>
      {/* Tripod feet */}
      {[0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((a, i) => (
        <mesh
          key={i}
          position={[Math.cos(a) * 0.18, 0.02, Math.sin(a) * 0.18]}
          rotation={[0, -a, 0]}
                 >
          <boxGeometry args={[0.2, 0.04, 0.04]} />
          <meshStandardMaterial map={woodTex} color="#3a1f10" roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

// Variant 3: Tall dark-wood pedestal mirroring Venus's stone base.
// Raises the TV so its silhouette matches Venus's height (~2.7m).
function MountTallPedestal({ woodTex, tvLift }: { woodTex: THREE.Texture; tvLift: number }) {
  return (
    <group>
      {/* Wide low plinth — base of the column */}
      <mesh position={[0, 0.06, 0]}  receiveShadow>
        <boxGeometry args={[0.75, 0.12, 0.55]} />
        <meshStandardMaterial color="#1a0f06" roughness={0.92} metalness={0.02} />
      </mesh>
      {/* Column shaft — tall, slim, subtly tapered */}
      <mesh position={[0, (tvLift - 0.12) / 2 + 0.12, 0]}  receiveShadow>
        <boxGeometry args={[0.55, tvLift - 0.24, 0.42]} />
        <meshStandardMaterial map={woodTex} color="#2a1a0e" roughness={0.82} metalness={0.05} />
      </mesh>
      {/* Cap — echoes Venus's pedestal shape, slightly wider than shaft */}
      <mesh position={[0, tvLift - 0.06, 0]}  receiveShadow>
        <boxGeometry args={[0.72, 0.12, 0.5]} />
        <meshStandardMaterial color="#1a0f06" roughness={0.9} metalness={0.02} />
      </mesh>
    </group>
  );
}

// Variant D: School / hospital AV cart — black steel frame + casters.
function MountCart({ tvLift }: { tvLift: number }) {
  const postH = tvLift - 0.05;
  return (
    <group>
      {/* Top shelf (TV sits here) */}
      <mesh position={[0, tvLift - 0.015, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.2, 0.025, 0.58]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.45} metalness={0.55} />
      </mesh>
      {/* Mid shelf */}
      <mesh position={[0, 0.32, 0]} >
        <boxGeometry args={[1.18, 0.02, 0.56]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.5} metalness={0.5} />
      </mesh>
      {/* Bottom shelf */}
      <mesh position={[0, 0.12, 0]} >
        <boxGeometry args={[1.18, 0.02, 0.56]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.5} metalness={0.5} />
      </mesh>
      {/* Four vertical posts */}
      {[
        [-0.54, -0.26],
        [0.54, -0.26],
        [-0.54, 0.26],
        [0.54, 0.26],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, (postH + 0.08) / 2 + 0.04, z]}>
          <cylinderGeometry args={[0.014, 0.014, postH, 10]} />
          <meshStandardMaterial color="#2a2a2a" metalness={0.8} roughness={0.35} />
        </mesh>
      ))}
      {/* Four caster wheels */}
      {[
        [-0.52, -0.24],
        [0.52, -0.24],
        [-0.52, 0.24],
        [0.52, 0.24],
      ].map(([x, z], i) => (
        <group key={i} position={[x, 0.04, z]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.035, 0.035, 0.02, 14]} />
            <meshStandardMaterial color="#1a1a1a" roughness={0.75} />
          </mesh>
          <mesh position={[0, 0.025, 0]}>
            <boxGeometry args={[0.022, 0.04, 0.04]} />
            <meshStandardMaterial color="#2a2a2a" metalness={0.7} roughness={0.45} />
          </mesh>
        </group>
      ))}
      {/* A few VHS tapes stacked on the bottom shelf (flavor) */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[-0.35 + i * 0.03, 0.15 + i * 0.022, 0]}>
          <boxGeometry args={[0.18, 0.02, 0.11]} />
          <meshStandardMaterial color={i === 1 ? "#3a1208" : "#1a1008"} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

// ——— TV screen content renderers. All called with pre-CRT ctx. ———

function drawStationID(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  ctx.fillStyle = "#06090f";
  ctx.fillRect(0, 0, W, H);

  // Pulsing radial glow centre (cool white)
  const pulse = 0.6 + Math.sin(t * 1.4) * 0.15;
  const glow = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.55);
  glow.addColorStop(0, `rgba(235,245,255,${0.18 * pulse})`);
  glow.addColorStop(1, "rgba(235,245,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = "rgb(240,248,255)";
  ctx.font = "bold 28px 'Times New Roman', serif";
  ctx.fillText("CHANNEL 15", W / 2, H * 0.28);

  ctx.font = "bold 56px 'Times New Roman', serif";
  ctx.letterSpacing = "14px" as unknown as string;
  ctx.fillText("W A R H O L    T V", W / 2, H * 0.46);
  ctx.letterSpacing = "0px" as unknown as string;

  // Warhol quote
  ctx.font = "italic 17px 'Times New Roman', serif";
  ctx.fillStyle = "rgb(215,225,240)";
  ctx.fillText('"In the future, everyone will be', W / 2, H * 0.64);
  ctx.fillText('famous for fifteen minutes."', W / 2, H * 0.71);

  ctx.font = "12px ui-monospace, monospace";
  ctx.fillStyle = "rgb(175,190,215)";
  ctx.fillText("— ANDY WARHOL, 1968", W / 2, H * 0.8);

  // Little corner bug
  ctx.textAlign = "left";
  ctx.font = "bold 10px ui-monospace, monospace";
  ctx.fillStyle = "rgb(235,245,255)";
  ctx.fillText("● CH 15", 16, 22);
}

function drawNextUp(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  who: Submitter, secsToShow: number, t: number,
) {
  ctx.fillStyle = "#070b13";
  ctx.fillRect(0, 0, W, H);

  // Top bar
  ctx.fillStyle = "rgb(225,235,250)";
  ctx.fillRect(0, 0, W, 36);
  ctx.fillStyle = "rgb(10,15,22)";
  ctx.font = "bold 20px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText("★   N E X T   U P   ★", W / 2, 25);

  // Portrait
  const pX = 30;
  const pY = 60;
  const pW = 180;
  const pH = 220;
  drawAvatar(ctx, pX, pY, pW, pH, who.avatarSeed);
  // portrait frame
  ctx.strokeStyle = "rgba(230,240,255,0.6)";
  ctx.lineWidth = 2;
  ctx.strokeRect(pX - 1, pY - 1, pW + 2, pH + 2);

  // Right column
  ctx.textAlign = "left";
  ctx.fillStyle = "rgb(235,245,255)";
  ctx.font = "bold 26px 'Times New Roman', serif";
  const name = who.name;
  const parts = name.length > 16 ? wrapText(ctx, name, W - pX - pW - 40) : [name];
  let ly = pY + 30;
  for (const p of parts) { ctx.fillText(p, pX + pW + 20, ly); ly += 30; }

  ctx.font = "14px ui-monospace, monospace";
  ctx.fillStyle = "rgb(180,195,220)";
  ctx.fillText(who.location, pX + pW + 20, ly + 4);
  ly += 28;

  // Quote
  ctx.font = "italic 18px 'Times New Roman', serif";
  ctx.fillStyle = "rgb(225,235,250)";
  const quote = `"${who.quote}"`;
  const lines = wrapText(ctx, quote, W - pX - pW - 40);
  for (const l of lines) { ctx.fillText(l, pX + pW + 20, ly); ly += 24; }

  // Countdown
  ctx.textAlign = "center";
  const timeStr = formatHMS(secsToShow);
  ctx.font = "bold 14px ui-monospace, monospace";
  ctx.fillStyle = "rgb(190,205,225)";
  ctx.fillText("ON AIR IN", W / 2, H - 58);
  ctx.font = "bold 36px ui-monospace, monospace";
  ctx.fillStyle = "rgb(235,245,255)";
  const tick = Math.floor(t * 2) % 2 === 0 ? timeStr : timeStr.replace(/:/g, " ");
  ctx.fillText(tick, W / 2, H - 24);
}

function drawLineup(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  queue: Submitter[], secsToShow: number, t: number,
) {
  ctx.fillStyle = "#06090f";
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = "rgb(235,245,255)";
  ctx.font = "bold 24px ui-monospace, monospace";
  ctx.fillText("COMING UP", W / 2, 32);

  // Six small portraits in a filmstrip
  const shown = queue.slice(0, 6);
  const cellW = (W - 32) / shown.length;
  const cellH = 90;
  for (let i = 0; i < shown.length; i++) {
    const x = 16 + i * cellW + 4;
    const y = 56;
    const w = cellW - 8;
    drawAvatar(ctx, x, y, w, cellH, shown[i].avatarSeed);
    ctx.strokeStyle = "rgba(210,225,245,0.55)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, cellH);
    // perforations
    ctx.fillStyle = "rgba(210,225,245,0.25)";
    for (let k = 0; k < 4; k++) {
      ctx.fillRect(x + 4 + k * (w - 8) / 3 - 3, y - 8, 6, 4);
      ctx.fillRect(x + 4 + k * (w - 8) / 3 - 3, y + cellH + 4, 6, 4);
    }
  }

  // Slot listing below
  ctx.textAlign = "left";
  ctx.font = "13px ui-monospace, monospace";
  const startY = 180;
  const slotMinutes = 15;
  const baseMin = Math.floor(secsToShow / 60);
  for (let i = 0; i < Math.min(6, queue.length); i++) {
    const y = startY + i * 22;
    const mins = baseMin + i * slotMinutes;
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    const eta = hh > 0 ? `+${hh}H ${mm.toString().padStart(2, "0")}M` : `+${mm}M`;
    // First row amber-warm to signify "next" against the cool CRT
    ctx.fillStyle = i === 0 ? "rgb(255,210,170)" : "rgb(225,235,250)";
    const dot = i === 0 ? "►" : "·";
    ctx.fillText(`${dot}  ${queue[i].name}`, 24, y);
    ctx.textAlign = "right";
    ctx.fillText(eta, W - 24, y);
    ctx.textAlign = "left";
  }
}

function drawOnAir(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  who: Submitter, remainingSecs: number, t: number,
) {
  // Full-bleed portrait
  drawAvatar(ctx, 0, 0, W, H, who.avatarSeed);

  // LIVE bug top-left — blinks
  const blink = Math.floor(t * 1.5) % 2 === 0;
  if (blink) {
    ctx.fillStyle = "rgba(180,40,40,0.9)";
    ctx.fillRect(16, 16, 84, 30);
    ctx.fillStyle = "rgb(255,245,240)";
    ctx.font = "bold 22px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("● LIVE", 58, 38);
  }

  // Name banner bottom
  ctx.fillStyle = "rgba(8,12,18,0.78)";
  ctx.fillRect(0, H - 76, W, 76);
  ctx.fillStyle = "rgb(235,245,255)";
  ctx.textAlign = "left";
  ctx.font = "bold 22px 'Times New Roman', serif";
  ctx.fillText(who.name, 20, H - 46);
  ctx.font = "14px ui-monospace, monospace";
  ctx.fillStyle = "rgb(185,200,225)";
  ctx.fillText(who.location, 20, H - 24);

  // Remaining time bottom-right
  ctx.textAlign = "right";
  ctx.font = "bold 26px ui-monospace, monospace";
  ctx.fillStyle = "rgb(240,248,255)";
  ctx.fillText(formatMS(remainingSecs), W - 20, H - 36);
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillStyle = "rgb(185,200,225)";
  ctx.fillText("REMAINING", W - 20, H - 18);
}

function drawChyron(
  ctx: CanvasRenderingContext2D, W: number, H: number, t: number, secsToShow: number,
) {
  const H_BAR = 24;
  const y = H - H_BAR;
  ctx.fillStyle = "rgba(10,15,22,0.9)";
  ctx.fillRect(0, y, W, H_BAR);
  ctx.strokeStyle = "rgba(185,200,225,0.5)";
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(W, y);
  ctx.stroke();

  // Left fixed: countdown
  ctx.fillStyle = "rgb(235,245,255)";
  ctx.font = "bold 13px ui-monospace, monospace";
  ctx.textAlign = "left";
  const blink = Math.floor(t * 2) % 2 === 0;
  const timeStr = formatHMS(secsToShow);
  ctx.fillText(`ON AIR IN  ${blink ? timeStr : timeStr.replace(/:/g, " ")}`, 10, y + 16);

  // Right: scrolling marquee of next names
  const names = TV_QUEUE.map((q) => q.name).join("   ·   ") + "   ·   ";
  ctx.font = "13px ui-monospace, monospace";
  const text = names + names; // loop
  const textW = ctx.measureText(text).width;
  const scroll = (t * 32) % (textW / 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(W * 0.4, y + 2, W * 0.6 - 8, H_BAR - 4);
  ctx.clip();
  ctx.fillStyle = "rgb(205,220,245)";
  ctx.fillText(text, W - 10 - scroll, y + 16);
  ctx.restore();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur); cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ————— camera with a gentle mouse-parallax rig —————

function CameraRig() {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });

  useFrame(({ mouse }) => {
    target.current.x = mouse.x * 0.3;
    target.current.y = mouse.y * 0.18;
    current.current.x += (target.current.x - current.current.x) * 0.06;
    current.current.y += (target.current.y - current.current.y) * 0.06;

    if (cameraRef.current) {
      cameraRef.current.position.x = current.current.x;
      cameraRef.current.position.y = 1.65 + current.current.y;
      cameraRef.current.lookAt(0, 3, -13);
    }
  });

  return (
    <PerspectiveCamera
      ref={cameraRef}
      makeDefault
      position={[0, 1.65, 6]}
      fov={55}
      near={0.1}
      far={80}
    />
  );
}

// ————— distributed altar lighting: altar spot + torchieres + sconces —————

function AltarSpot() {
  // Broader, softer spotlight on the stage — more "altar highlight"
  // than "interrogation lamp". Gentle flicker baked in.
  const ref = useRef<THREE.SpotLight>(null);
  useFrame(({ clock }) => {
    if (ref.current) {
      const t = clock.elapsedTime;
      const flicker =
        Math.sin(t * 1.9) * 0.05 +
        Math.sin(t * 3.3 + 0.8) * 0.03 +
        Math.sin(t * 5.7 + 0.2) * 0.02;
      ref.current.intensity = 32 + flicker * 8;
    }
  });
  return (
    <spotLight
      ref={ref}
      position={[0, 11, -4]}
      angle={Math.PI / 3}
      penumbra={0.85}
      intensity={32}
      distance={26}
      decay={1.4}
      color="#f2cc86"
      castShadow
      shadow-mapSize={[512, 512]}
    >
      <object3D position={[0, 1.5, -13]} attach="target" />
    </spotLight>
  );
}

// A Twin-Peaks / La Tour style torchiere: a visible thin brass pole
// with a small bowl at the top, and a warm pointLight sitting in the
// bowl. The LIGHT HAS A VISIBLE SOURCE — that's what makes it
// devotional rather than arbitrary.
function Torchiere({ position }: { position: [number, number, number] }) {
  const lightRef = useRef<THREE.PointLight>(null);
  const bulbRef = useRef<THREE.Mesh>(null);
  const seed = useMemo(() => Math.random() * 10, []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + seed;
    const f = 1 + Math.sin(t * 2.4) * 0.05 + Math.sin(t * 5.1) * 0.03;
    if (lightRef.current) lightRef.current.intensity = 11 * f;
    if (bulbRef.current) {
      (bulbRef.current.material as THREE.MeshBasicMaterial).opacity = 0.85 * f;
    }
  });
  return (
    <group position={position}>
      {/* Base disc */}
      <mesh position={[0, 0.04, 0]} >
        <cylinderGeometry args={[0.22, 0.26, 0.08, 24]} />
        <meshStandardMaterial color="#3a2a14" metalness={0.7} roughness={0.55} />
      </mesh>
      {/* Thin brass pole */}
      <mesh position={[0, 1.5, 0]} >
        <cylinderGeometry args={[0.03, 0.03, 3, 12]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.4} />
      </mesh>
      {/* Bowl at top — shallow cone, open upward */}
      <mesh position={[0, 3.08, 0]} >
        <coneGeometry args={[0.35, 0.18, 24, 1, true]} />
        <meshStandardMaterial
          color="#4a3518"
          metalness={0.65}
          roughness={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Inner bowl glow disc — warm emissive, visible as the 'flame' */}
      <mesh position={[0, 3.13, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.25, 24]} />
        <meshBasicMaterial
          color="#ffc880"
          toneMapped={false}
          transparent
          opacity={0.85}
        />
      </mesh>
      {/* The actual light emitted upward & outward */}
      <pointLight
        ref={lightRef}
        position={[0, 3.2, 0]}
        color="#f0b070"
        intensity={11}
        distance={14}
        decay={1.4}
      />
    </group>
  );
}

function SideSconce({ position }: { position: [number, number, number] }) {
  const ref = useRef<THREE.PointLight>(null);
  const seed = useMemo(() => Math.random() * 10, []);
  useFrame(({ clock }) => {
    if (ref.current) {
      const t = clock.elapsedTime + seed;
      const f = Math.sin(t * 4.1) * 0.18 + Math.sin(t * 6.7) * 0.09;
      ref.current.intensity = 4.2 + f;
    }
  });
  return (
    <pointLight
      ref={ref}
      position={position}
      color="#e0a050"
      intensity={4.2}
      distance={6}
      decay={1.7}
    />
  );
}

// ————— 3a red carpet —————
// A long dark-crimson runner from the camera's feet to the stage
// front. Pins the eye to the central axis and gives the room a
// processional spine.

function RedCarpet() {
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.015, -3.5]}
        receiveShadow
      >
        <planeGeometry args={[2.6, 18, 1, 1]} />
        <meshPhysicalMaterial
          color="#3a0808"
          roughness={0.96}
          metalness={0}
          sheen={1}
          sheenColor="#8a1818"
          sheenRoughness={0.35}
          emissive="#120202"
          emissiveIntensity={0.25}
        />
      </mesh>
      {/* Thin brass edge trim along each side */}
      <mesh position={[-1.3, 0.02, -3.5]} >
        <boxGeometry args={[0.04, 0.02, 18]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.45} />
      </mesh>
      <mesh position={[1.3, 0.02, -3.5]} >
        <boxGeometry args={[0.04, 0.02, 18]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.45} />
      </mesh>
    </group>
  );
}

// ————— 3b candelabra —————
// A low brass three-candle stand. Each candle has its own flicker
// phase. Placed on the stage as if the ceremony is already prepared.

function Candelabra({ position }: { position: [number, number, number] }) {
  const lightRefs = useRef<Array<THREE.PointLight | null>>([null, null, null]);
  const flameRefs = useRef<Array<THREE.Mesh | null>>([null, null, null]);
  const seeds = useMemo(
    () => [Math.random() * 10, Math.random() * 10, Math.random() * 10],
    [],
  );

  useFrame(({ clock }) => {
    for (let i = 0; i < 3; i++) {
      const l = lightRefs.current[i];
      const f = flameRefs.current[i];
      const t = clock.elapsedTime + seeds[i];
      const flick =
        1 + Math.sin(t * 3.2) * 0.22 + Math.sin(t * 7.1 + 0.4) * 0.14;
      if (l) l.intensity = 1.8 * flick;
      if (f) f.scale.setScalar(0.9 + 0.25 * (flick - 1) * 2);
    }
  });

  const branches: Array<[number, number]> = [
    [-0.28, 0],
    [0, 0.09],
    [0.28, 0],
  ];

  return (
    <group position={position}>
      {/* Base disc */}
      <mesh position={[0, 0.04, 0]} >
        <cylinderGeometry args={[0.16, 0.2, 0.08, 24]} />
        <meshStandardMaterial color="#3a2614" metalness={0.7} roughness={0.5} />
      </mesh>
      {/* Stem */}
      <mesh position={[0, 0.45, 0]} >
        <cylinderGeometry args={[0.025, 0.028, 0.8, 14]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.4} />
      </mesh>
      {/* Crossbar */}
      <mesh position={[0, 0.84, 0]} rotation={[0, 0, Math.PI / 2]} >
        <cylinderGeometry args={[0.02, 0.02, 0.62, 12]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.4} />
      </mesh>
      {branches.map(([dx, dy], i) => (
        <group key={i} position={[dx, 0.88 + dy, 0]}>
          {/* Tiny cup */}
          <mesh position={[0, 0.02, 0]} >
            <cylinderGeometry args={[0.05, 0.04, 0.03, 14]} />
            <meshStandardMaterial
              color="#8b6a34"
              metalness={0.8}
              roughness={0.4}
            />
          </mesh>
          {/* Candle wax */}
          <mesh position={[0, 0.11, 0]} >
            <cylinderGeometry args={[0.035, 0.035, 0.16, 10]} />
            <meshStandardMaterial color="#f2e6ca" roughness={0.75} />
          </mesh>
          {/* Flame glow sphere */}
          <mesh
            ref={(el) => {
              flameRefs.current[i] = el;
            }}
            position={[0, 0.24, 0]}
          >
            <sphereGeometry args={[0.05, 10, 10]} />
            <meshBasicMaterial color="#ffd08a" toneMapped={false} />
          </mesh>
          {/* Light */}
          <pointLight
            ref={(el) => {
              lightRefs.current[i] = el;
            }}
            position={[0, 0.26, 0]}
            color="#f0b070"
            intensity={1.8}
            distance={5.5}
            decay={1.6}
          />
        </group>
      ))}
    </group>
  );
}

// ————— 3d velvet armchair —————
// A plush velvet Twin-Peaks-style armchair: wide, low, padded arms,
// rolled back. Backs face the camera, facing the stage.

function VelvetChair({
  position,
  rotation = [0, 0, 0],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
}) {
  const velvet = (
    <meshPhysicalMaterial
      color="#5a0f0f"
      roughness={0.95}
      metalness={0}
      sheen={1}
      sheenColor="#b02828"
      sheenRoughness={0.4}
      emissive="#1a0303"
      emissiveIntensity={0.22}
    />
  );
  return (
    <group position={position} rotation={rotation}>
      {/* Wooden frame under the cushions */}
      <mesh position={[0, 0.18, 0]}  receiveShadow>
        <boxGeometry args={[1.05, 0.22, 0.82]} />
        <meshStandardMaterial
          color="#2a1608"
          roughness={0.6}
          metalness={0.3}
        />
      </mesh>
      {/* Seat cushion — puffy */}
      <mesh position={[0, 0.42, 0]}  receiveShadow>
        <boxGeometry args={[0.82, 0.18, 0.68]} />
        {velvet}
      </mesh>
      {/* Back cushion — tall, padded */}
      <mesh position={[0, 0.85, 0.3]} >
        <boxGeometry args={[0.82, 0.72, 0.2]} />
        {velvet}
      </mesh>
      {/* Rolled bolster at top of back */}
      <mesh
        position={[0, 1.24, 0.3]}
        rotation={[0, 0, Math.PI / 2]}
             >
        <cylinderGeometry args={[0.1, 0.1, 0.82, 20]} />
        {velvet}
      </mesh>
      {/* Left arm — padded block */}
      <mesh position={[-0.46, 0.58, 0.05]} >
        <boxGeometry args={[0.18, 0.5, 0.72]} />
        {velvet}
      </mesh>
      {/* Right arm */}
      <mesh position={[0.46, 0.58, 0.05]} >
        <boxGeometry args={[0.18, 0.5, 0.72]} />
        {velvet}
      </mesh>
      {/* Arm top rolls */}
      <mesh
        position={[-0.46, 0.85, 0.05]}
        rotation={[Math.PI / 2, 0, 0]}
             >
        <cylinderGeometry args={[0.09, 0.09, 0.72, 16]} />
        {velvet}
      </mesh>
      <mesh
        position={[0.46, 0.85, 0.05]}
        rotation={[Math.PI / 2, 0, 0]}
             >
        <cylinderGeometry args={[0.09, 0.09, 0.72, 16]} />
        {velvet}
      </mesh>
      {/* Four squat feet */}
      {(
        [
          [-0.42, 0.04, -0.34],
          [0.42, 0.04, -0.34],
          [-0.42, 0.04, 0.34],
          [0.42, 0.04, 0.34],
        ] as Array<[number, number, number]>
      ).map((p, i) => (
        <mesh key={i} position={p} >
          <cylinderGeometry args={[0.05, 0.05, 0.08, 10]} />
          <meshStandardMaterial
            color="#8b6a34"
            metalness={0.8}
            roughness={0.45}
          />
        </mesh>
      ))}
    </group>
  );
}

// FloorLamp — Twin-Peaks-style standing lamp. Thin brass pole, fabric
// tulip shade, dim blood-amber emission that paints the chevron floor
// with a warm pool. Called next to each audience pair.
function FloorLamp({ position }: { position: [number, number, number] }) {
  const lightRef = useRef<THREE.PointLight | null>(null);
  // Per-lamp random phase so the 4 lamps don't flicker in lockstep
  const phase = useMemo(() => position[0] * 3.1 + position[2] * 1.7, [position]);

  useFrame(({ clock }) => {
    if (!lightRef.current) return;
    const t = clock.elapsedTime + phase;
    // Slow candle-like wobble + occasional deeper dip. Intensity 0-1.
    const base = 0.82;
    const wobble = Math.sin(t * 1.9) * 0.06 + Math.sin(t * 7.3) * 0.035;
    const gust = Math.sin(t * 0.4) < -0.7 ? -0.18 : 0;
    lightRef.current.intensity = base + wobble + gust;
  });

  return (
    <group position={position}>
      {/* Weighted round base */}
      <mesh position={[0, 0.025, 0]}  receiveShadow>
        <cylinderGeometry args={[0.16, 0.18, 0.05, 24]} />
        <meshStandardMaterial color="#3a2a0f" metalness={0.65} roughness={0.5} />
      </mesh>
      {/* Base highlight ring */}
      <mesh position={[0, 0.055, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 0.01, 24]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.85} roughness={0.35} />
      </mesh>
      {/* Slim brass pole — taller than before (+15cm) */}
      <mesh position={[0, 0.97, 0]} >
        <cylinderGeometry args={[0.014, 0.016, 1.85, 12]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.85} roughness={0.35} />
      </mesh>
      {/* Small decorative ball at pole top */}
      <mesh position={[0, 1.90, 0]} >
        <sphereGeometry args={[0.022, 12, 10]} />
        <meshStandardMaterial color="#b8934a" metalness={0.8} roughness={0.35} />
      </mesh>
      {/* Fabric lampshade — warm amber/gold now (more yellow than the
          previous blood-amber). Emissive so it reads as glowing. */}
      <mesh position={[0, 2.17, 0]} >
        <cylinderGeometry args={[0.18, 0.24, 0.34, 20, 1, true]} />
        <meshStandardMaterial
          color="#6a3418"
          emissive="#d8781c"
          emissiveIntensity={1.25}
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Shade top cap */}
      <mesh position={[0, 2.345, 0]}>
        <cylinderGeometry args={[0.175, 0.175, 0.006, 20]} />
        <meshStandardMaterial color="#2a1008" roughness={0.9} />
      </mesh>
      {/* Bulb glow blob — warmer yellow bulb */}
      <mesh position={[0, 2.15, 0]}>
        <sphereGeometry args={[0.07, 14, 10]} />
        <meshBasicMaterial color="#ffc880" toneMapped={false} />
      </mesh>
      {/* The actual light emission — shifted from blood-amber (#c84818,
          red-orange) to warm amber (#d8802c, gold-amber). Still "dim
          and candid," just more yellow so it reads as lamp-light
          rather than firelight. */}
      <pointLight
        ref={lightRef}
        position={[0, 2.13, 0]}
        color="#d8802c"
        intensity={0.88}
        distance={4.4}
        decay={1.9}
      />
    </group>
  );
}

// VelvetBigChair — an oversize single-seater armchair (throne-ish).
// Same velvet language as VelvetChair, but ~40% wider + slightly
// taller so it reads as "the one seat that matters". Used for the
// lone TV-bearing seat on front-right.
function VelvetBigChair({
  position,
  rotation = [0, 0, 0],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
}) {
  const velvet = (
    <meshPhysicalMaterial
      color="#5a0f0f"
      roughness={0.95}
      metalness={0}
      sheen={1}
      sheenColor="#b02828"
      sheenRoughness={0.4}
      emissive="#1a0303"
      emissiveIntensity={0.22}
    />
  );
  const W = 1.45; // wider than regular 1.05
  const D = 0.92; // slightly deeper too
  return (
    <group position={position} rotation={rotation}>
      {/* Wooden frame under the cushions */}
      <mesh position={[0, 0.2, 0]}  receiveShadow>
        <boxGeometry args={[W + 0.05, 0.24, D]} />
        <meshStandardMaterial color="#2a1608" roughness={0.6} metalness={0.3} />
      </mesh>
      {/* Single plush seat cushion — one wide pad */}
      <mesh position={[0, 0.46, 0]}  receiveShadow>
        <boxGeometry args={[W - 0.18, 0.2, D - 0.18]} />
        {velvet}
      </mesh>
      {/* Back cushion — tall, padded */}
      <mesh position={[0, 0.95, 0.35]} >
        <boxGeometry args={[W - 0.06, 0.82, 0.22]} />
        {velvet}
      </mesh>
      {/* Rolled bolster at top of back */}
      <mesh
        position={[0, 1.38, 0.35]}
        rotation={[0, 0, Math.PI / 2]}
             >
        <cylinderGeometry args={[0.11, 0.11, W - 0.06, 20]} />
        {velvet}
      </mesh>
      {/* Left arm */}
      <mesh position={[-(W / 2) - 0.01, 0.62, 0.05]} >
        <boxGeometry args={[0.2, 0.56, D - 0.1]} />
        {velvet}
      </mesh>
      {/* Right arm */}
      <mesh position={[(W / 2) + 0.01, 0.62, 0.05]} >
        <boxGeometry args={[0.2, 0.56, D - 0.1]} />
        {velvet}
      </mesh>
      {/* Arm top rolls */}
      <mesh
        position={[-(W / 2) - 0.01, 0.94, 0.05]}
        rotation={[Math.PI / 2, 0, 0]}
             >
        <cylinderGeometry args={[0.1, 0.1, D - 0.1, 16]} />
        {velvet}
      </mesh>
      <mesh
        position={[(W / 2) + 0.01, 0.94, 0.05]}
        rotation={[Math.PI / 2, 0, 0]}
             >
        <cylinderGeometry args={[0.1, 0.1, D - 0.1, 16]} />
        {velvet}
      </mesh>
      {/* Four stout brass feet */}
      {(
        [
          [-(W / 2) + 0.12, 0.04, -(D / 2) + 0.1],
          [(W / 2) - 0.12, 0.04, -(D / 2) + 0.1],
          [-(W / 2) + 0.12, 0.04, (D / 2) - 0.1],
          [(W / 2) - 0.12, 0.04, (D / 2) - 0.1],
        ] as Array<[number, number, number]>
      ).map((p, i) => (
        <mesh key={i} position={p} >
          <cylinderGeometry args={[0.055, 0.055, 0.08, 10]} />
          <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.45} />
        </mesh>
      ))}
    </group>
  );
}

// VelvetSofa — a 2-seater loveseat using the same velvet as the chairs,
// same silhouette language (puffy cushions, rolled bolster, wooden frame,
// brass feet) but ~2m wide so two people (or one person + a companion
// object) can share it.
function VelvetSofa({
  position,
  rotation = [0, 0, 0],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
}) {
  const velvet = (
    <meshPhysicalMaterial
      color="#5a0f0f"
      roughness={0.95}
      metalness={0}
      sheen={1}
      sheenColor="#b02828"
      sheenRoughness={0.4}
      emissive="#1a0303"
      emissiveIntensity={0.22}
    />
  );
  const W = 2.3; // sofa width
  return (
    <group position={position} rotation={rotation}>
      {/* Wooden frame under the cushions */}
      <mesh position={[0, 0.18, 0]}  receiveShadow>
        <boxGeometry args={[W + 0.05, 0.22, 0.82]} />
        <meshStandardMaterial color="#2a1608" roughness={0.6} metalness={0.3} />
      </mesh>
      {/* Two seat cushions side-by-side */}
      <mesh position={[-W / 4, 0.42, 0]}  receiveShadow>
        <boxGeometry args={[W / 2 - 0.04, 0.18, 0.68]} />
        {velvet}
      </mesh>
      <mesh position={[W / 4, 0.42, 0]}  receiveShadow>
        <boxGeometry args={[W / 2 - 0.04, 0.18, 0.68]} />
        {velvet}
      </mesh>
      {/* Back cushion — one long pad across the whole width */}
      <mesh position={[0, 0.85, 0.3]} >
        <boxGeometry args={[W, 0.72, 0.2]} />
        {velvet}
      </mesh>
      {/* Rolled bolster at top of back */}
      <mesh position={[0, 1.24, 0.3]} rotation={[0, 0, Math.PI / 2]} >
        <cylinderGeometry args={[0.1, 0.1, W, 20]} />
        {velvet}
      </mesh>
      {/* Left arm */}
      <mesh position={[-(W / 2) - 0.01, 0.58, 0.05]} >
        <boxGeometry args={[0.18, 0.5, 0.72]} />
        {velvet}
      </mesh>
      {/* Right arm */}
      <mesh position={[(W / 2) + 0.01, 0.58, 0.05]} >
        <boxGeometry args={[0.18, 0.5, 0.72]} />
        {velvet}
      </mesh>
      {/* Arm top rolls */}
      <mesh
        position={[-(W / 2) - 0.01, 0.85, 0.05]}
        rotation={[Math.PI / 2, 0, 0]}
             >
        <cylinderGeometry args={[0.09, 0.09, 0.72, 16]} />
        {velvet}
      </mesh>
      <mesh
        position={[(W / 2) + 0.01, 0.85, 0.05]}
        rotation={[Math.PI / 2, 0, 0]}
             >
        <cylinderGeometry args={[0.09, 0.09, 0.72, 16]} />
        {velvet}
      </mesh>
      {/* Six brass feet (three on each long side) */}
      {(
        [
          [-(W / 2) + 0.1, 0.04, -0.34],
          [0, 0.04, -0.34],
          [(W / 2) - 0.1, 0.04, -0.34],
          [-(W / 2) + 0.1, 0.04, 0.34],
          [0, 0.04, 0.34],
          [(W / 2) - 0.1, 0.04, 0.34],
        ] as Array<[number, number, number]>
      ).map((p, i) => (
        <mesh key={i} position={p} >
          <cylinderGeometry args={[0.05, 0.05, 0.08, 10]} />
          <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.45} />
        </mesh>
      ))}
    </group>
  );
}

// ————— CandleStand — replaces torchiere —————
// A short wooden/stone prayer-stand with a cluster of pillar candles
// of varying heights. Each candle flickers on its own phase.

function CandleStand({ position }: { position: [number, number, number] }) {
  const N = 5;
  const lightRefs = useRef<Array<THREE.PointLight | null>>(
    Array(N).fill(null),
  );
  const flameRefs = useRef<Array<THREE.Mesh | null>>(Array(N).fill(null));
  const candles = useMemo(() => {
    const out: Array<{ x: number; z: number; h: number; seed: number }> = [];
    // Cluster arrangement on top of stand
    const cluster: Array<[number, number]> = [
      [-0.22, -0.08],
      [-0.08, 0.1],
      [0.08, -0.05],
      [0.22, 0.08],
      [0.0, -0.18],
    ];
    for (let i = 0; i < N; i++) {
      out.push({
        x: cluster[i][0],
        z: cluster[i][1],
        h: 0.26 + Math.random() * 0.3,
        seed: Math.random() * 10,
      });
    }
    return out;
  }, []);
  useFrame(({ clock }) => {
    for (let i = 0; i < N; i++) {
      const l = lightRefs.current[i];
      const f = flameRefs.current[i];
      const t = clock.elapsedTime + candles[i].seed;
      const flick =
        1 + Math.sin(t * 3.1) * 0.22 + Math.sin(t * 7.3 + 0.4) * 0.13;
      if (l) l.intensity = 2.1 * flick;
      if (f) f.scale.setScalar(0.88 + 0.22 * (flick - 1) * 2);
    }
  });
  return (
    <group position={position}>
      {/* Base — short wooden block */}
      <mesh position={[0, 0.06, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.7, 0.12, 0.5]} />
        <meshStandardMaterial
          color="#2a1608"
          roughness={0.88}
          metalness={0.08}
        />
      </mesh>
      {/* Thin brass trim around base top */}
      <mesh position={[0, 0.125, 0]} >
        <boxGeometry args={[0.74, 0.015, 0.54]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.45} />
      </mesh>
      {candles.map((c, i) => (
        <group key={i} position={[c.x, 0.14, c.z]}>
          <mesh position={[0, c.h / 2, 0]} castShadow>
            <cylinderGeometry args={[0.045, 0.05, c.h, 12]} />
            <meshStandardMaterial color="#f2e6ca" roughness={0.75} />
          </mesh>
          <mesh
            ref={(el) => {
              flameRefs.current[i] = el;
            }}
            position={[0, c.h + 0.05, 0]}
          >
            <sphereGeometry args={[0.055, 10, 10]} />
            <meshBasicMaterial color="#ffd08a" toneMapped={false} />
          </mesh>
          <pointLight
            ref={(el) => {
              lightRefs.current[i] = el;
            }}
            position={[0, c.h + 0.07, 0]}
            color="#f0b070"
            intensity={2.1}
            distance={8}
            decay={1.5}
          />
        </group>
      ))}
    </group>
  );
}

// ————— 4iii dust motes — drei <Sparkles> —————
// Replaced the hand-rolled Points loop with drei's Sparkles, which
// handles spawning, drift, and size-attenuation internally. The
// scale box keeps motes confined to the central corridor (away from
// the side curtains). Speed is low so they drift rather than dart.

function DustMotes() {
  return (
    <Sparkles
      count={40}
      // Wider spread — was [9,5,12] (centre-heavy). Now covers most of
      // the visible room so motes aren't clumped in the middle.
      scale={[17, 7, 15]}
      position={[0, 3.2, -4]}
      size={1.4}
      speed={0.18}
      opacity={0.28}
      color="#d8a46a"
      noise={0.5}
    />
  );
}

// ————— Indoor drizzle spectacle —————
// Surreal indoor rain — Twin Peaks-style. Light, atmospheric, never
// dominant. Each drop is a short LINE SEGMENT (not a point) so it
// reads as a vertical streak rather than a hailstone pellet.
//
// State machine — every rain event has four phases:
//   dry      → idle, no drops rendered (50–80s)
//   ramp-in  → opacity 0 → max over 2s (sparse drizzle thickening)
//   steady   → full max opacity (LOG-NORMAL distributed, see below)
//   ramp-out → opacity max → 0 over 2s (drizzle dying away)
//
// Steady duration is sampled from a log-normal distribution with
// median 21s (so total visible rain ≈25s including the 4s of ramps)
// and σ_log = 1.0, then clamped to [1, 296] so total is in [5, 300].
// This gives:
//   ~50% of events between 13–49s total
//   ~25% short showers 5–13s
//   ~25% long downpours 49–300s (occasional 5-min storms)
//
// Rendering choices:
// - LineSegments: each drop is a 0.35m vertical streak. WebGL
//   limits hardware line width to 1px on most platforms — that's
//   actually what we want, thin streaks read as real rain rather
//   than chunky spheres.
// - Pale grey-white tint (#d0d8e4): real rain isn't blue, but a
//   faint blue keeps it from looking like ash.
// - Low max opacity (0.4): user requirement "不要看着太明显". The
//   rain sits underneath the scene's other dramatic events as
//   ambient texture, not stealing focus.
// - depthWrite: false (drops don't z-fight each other) but depth
//   TEST stays on, so the back curtain / stage curtain / Venus
//   correctly occlude drops behind them.

function Rain() {
  const N = 220;
  const STREAK_LEN = 0.35;
  const Y_RANGE = 11;       // total fall range (top - floor)
  const Y_TOP = 11;          // y where drops respawn
  const MAX_OPACITY = 0.4;
  const RAMP_IN_DUR = 2.0;
  const RAMP_OUT_DUR = 2.0;

  const linesRef = useRef<THREE.LineSegments>(null);

  // Build geometry ONCE at mount with per-vertex attributes that the
  // shader reads to compute current y. CPU never touches positions
  // again — the entire animation runs on the GPU via uTime uniform.
  // This eliminates the per-frame buffer upload (was 6.7KB × 60fps =
  // 400KB/s) AND the per-frame loop over N drops (was the visible
  // FPS hit during long steady-rain phases now that they can last
  // up to 5 minutes).
  const geometry = useMemo(() => {
    // 2 vertices per segment, N segments
    const dropX = new Float32Array(N * 2);
    const dropZ = new Float32Array(N * 2);
    const dropPhase = new Float32Array(N * 2);    // 0..1 init offset
    const dropVelocity = new Float32Array(N * 2); // m/s
    const isBottom = new Float32Array(N * 2);     // 0=top, 1=bottom

    // BufferGeometry needs SOME `position` attribute even though
    // the shader replaces gl_Position with computed values. Use a
    // dummy zeroed buffer.
    const positions = new Float32Array(N * 6);

    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 18;     // x: -9 to 9
      const z = (Math.random() - 0.5) * 14 - 3; // z: -10 to 4
      const phase = Math.random();              // randomise initial fall position
      const velocity = 5 + Math.random() * 2;   // 5–7 m/s drizzle pace
      // Top vertex
      dropX[i * 2 + 0] = x;
      dropZ[i * 2 + 0] = z;
      dropPhase[i * 2 + 0] = phase;
      dropVelocity[i * 2 + 0] = velocity;
      isBottom[i * 2 + 0] = 0;
      // Bottom vertex (same drop, but flagged)
      dropX[i * 2 + 1] = x;
      dropZ[i * 2 + 1] = z;
      dropPhase[i * 2 + 1] = phase;
      dropVelocity[i * 2 + 1] = velocity;
      isBottom[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("aDropX", new THREE.BufferAttribute(dropX, 1));
    g.setAttribute("aDropZ", new THREE.BufferAttribute(dropZ, 1));
    g.setAttribute("aDropPhase", new THREE.BufferAttribute(dropPhase, 1));
    g.setAttribute("aDropVelocity", new THREE.BufferAttribute(dropVelocity, 1));
    g.setAttribute("aIsBottom", new THREE.BufferAttribute(isBottom, 1));
    // Disable frustum culling — bounding sphere is computed from the
    // dummy positions (all 0), so frustum test would think the mesh
    // is at origin. The shader places vertices wherever, so we just
    // tell three.js to always draw it.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 5, -3), 30);
    return g;
  }, []);

  // ShaderMaterial: vertex shader computes current y from
  // mod(phase * Y_RANGE + velocity * uTime, Y_RANGE), so each drop
  // wraps automatically when it hits the floor. uOpacity controls
  // ramp-in / ramp-out fade.
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: 0 },
          uColor: { value: new THREE.Color("#d0d8e4") },
          uYRange: { value: Y_RANGE },
          uYTop: { value: Y_TOP },
          uStreakLen: { value: STREAK_LEN },
        },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform float uYRange;
          uniform float uYTop;
          uniform float uStreakLen;
          attribute float aDropX;
          attribute float aDropZ;
          attribute float aDropPhase;
          attribute float aDropVelocity;
          attribute float aIsBottom;
          void main() {
            float wrapped = mod(aDropPhase * uYRange + aDropVelocity * uTime, uYRange);
            float topY = uYTop - wrapped;
            float y = topY - uStreakLen * aIsBottom;
            vec4 mv = modelViewMatrix * vec4(aDropX, y, aDropZ, 1.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uOpacity;
          void main() {
            gl_FragColor = vec4(uColor, uOpacity);
          }
        `,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );

  type Phase = "dry" | "ramp-in" | "steady" | "ramp-out";
  const cycle = useRef<{ phase: Phase; phaseStart: number; phaseDuration: number }>({
    phase: "dry",
    phaseStart: 0,
    phaseDuration: 8 + Math.random() * 8,
  });

  // Log-normal sample for steady-rain duration. Median 21s + 4s of
  // ramp-in/out ≈ 25s total median. Clamped to [1, 296] so total is
  // in user's requested [5, 300] window.
  const pickSteadyDuration = (): number => {
    const u = Math.max(1e-9, Math.random());
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const value = 21 * Math.exp(1.0 * z);
    return Math.min(296, Math.max(1, value));
  };

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    let elapsed = t - cycle.current.phaseStart;

    if (elapsed > cycle.current.phaseDuration) {
      cycle.current.phaseStart = t;
      elapsed = 0;
      switch (cycle.current.phase) {
        case "dry":
          cycle.current.phase = "ramp-in";
          cycle.current.phaseDuration = RAMP_IN_DUR;
          break;
        case "ramp-in":
          cycle.current.phase = "steady";
          cycle.current.phaseDuration = pickSteadyDuration();
          break;
        case "steady":
          cycle.current.phase = "ramp-out";
          cycle.current.phaseDuration = RAMP_OUT_DUR;
          break;
        case "ramp-out":
          cycle.current.phase = "dry";
          cycle.current.phaseDuration = 50 + Math.random() * 30;
          break;
      }
    }

    let opacity = 0;
    if (cycle.current.phase === "ramp-in") {
      opacity = (elapsed / RAMP_IN_DUR) * MAX_OPACITY;
    } else if (cycle.current.phase === "steady") {
      opacity = MAX_OPACITY;
    } else if (cycle.current.phase === "ramp-out") {
      opacity = (1 - elapsed / RAMP_OUT_DUR) * MAX_OPACITY;
    }

    // The only per-frame work: 2 uniform writes.
    material.uniforms.uTime.value = t;
    material.uniforms.uOpacity.value = opacity;
    if (linesRef.current) linesRef.current.visible = opacity > 0.001;
  });

  return (
    <lineSegments
      ref={linesRef}
      geometry={geometry}
      material={material}
      visible={false}
    />
  );
}

// ————— Lightning flash spectacle —————
// Brief room-wide white flash, like a flashbulb or distant lightning
// strike. Implementation: AmbientLight pulsed from 0 → ~5 for short
// bursts. Room's existing lights are 1–3, so 5 of pure-white ambient
// does whitewash the scene.
//
// Per event:
//   - Number of strokes weighted random:
//       40% single, 30% double, 20% triple, 10% 4–6 strokes
//   - Each stroke 50–150ms, intensity 0.5×–1.0× peak (varies stroke
//     to stroke so multi-stroke bursts don't feel uniform)
//   - Gaps between strokes within event: 50–250ms
//
// Inter-event interval mixes three regimes for "stormy" feel:
//   - 25% chance: close follow-up (3–12s) — same storm
//   - 60% chance: standard gap (20–90s)
//   - 15% chance: long quiet (90–240s)

const FLASH_PEAK_INTENSITY = 5.0;

function LightningFlash() {
  const lightRef = useRef<THREE.AmbientLight>(null);

  // A flash event has N bursts. Each burst is (start_offset_in_event,
  // duration, intensity_multiplier). Outside any burst, light = 0.
  type Burst = { startOffset: number; duration: number; intensity: number };
  const cycle = useRef({
    flashing: false,
    flashStart: 0,
    nextFlashAt: 15 + Math.random() * 25, // first flash 15–40s in
    bursts: [] as Burst[],
  });

  // Weighted stroke count: more often 1–2, occasionally 4–6.
  const pickBurstCount = (): number => {
    const r = Math.random();
    if (r < 0.40) return 1;
    if (r < 0.70) return 2;
    if (r < 0.90) return 3;
    return 4 + Math.floor(Math.random() * 3); // 4, 5, or 6
  };

  // Build a burst sequence with random gaps and intensity variation.
  const buildBursts = (): Burst[] => {
    const count = pickBurstCount();
    const bursts: Burst[] = [];
    let offset = 0;
    for (let i = 0; i < count; i++) {
      const duration = 0.05 + Math.random() * 0.10;     // 50–150ms
      const intensity = 0.5 + Math.random() * 0.5;       // 0.5×–1.0× peak
      bursts.push({ startOffset: offset, duration, intensity });
      if (i < count - 1) {
        const gap = 0.05 + Math.random() * 0.20;         // 50–250ms gap
        offset += duration + gap;
      }
    }
    return bursts;
  };

  // Mixed-regime gap so cadence doesn't feel uniform.
  const pickNextFlashGap = (): number => {
    const r = Math.random();
    if (r < 0.25) return 3 + Math.random() * 9;          // 3–12s close follow-up
    if (r < 0.85) return 20 + Math.random() * 70;        // 20–90s standard
    return 90 + Math.random() * 150;                     // 90–240s long quiet
  };

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Schedule next flash event.
    if (!cycle.current.flashing && t > cycle.current.nextFlashAt) {
      cycle.current.flashing = true;
      cycle.current.flashStart = t;
      cycle.current.bursts = buildBursts();
    }

    if (!cycle.current.flashing) {
      if (lightRef.current) lightRef.current.intensity = 0;
      return;
    }

    const dt = t - cycle.current.flashStart;

    // Find active burst (if any) and apply its per-burst intensity.
    let intensity = 0;
    for (const b of cycle.current.bursts) {
      if (dt >= b.startOffset && dt < b.startOffset + b.duration) {
        intensity = FLASH_PEAK_INTENSITY * b.intensity;
        break;
      }
    }
    if (lightRef.current) lightRef.current.intensity = intensity;

    // End the event after the last burst finishes. Schedule next.
    const last = cycle.current.bursts[cycle.current.bursts.length - 1];
    if (dt > last.startOffset + last.duration) {
      cycle.current.flashing = false;
      cycle.current.nextFlashAt = t + pickNextFlashGap();
    }
  });

  return <ambientLight ref={lightRef} color="#ffffff" intensity={0} />;
}

// ————— 4iv walker —————
// Every 45s or so a slender dark silhouette crosses the stage in
// front of the closed curtain, right to left or left to right
// alternately. Not aggressive — a slow, deliberate passage, fade
// in and out at the edges.

function Walker() {
  const groupRef = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);

  const figShape = useMemo(() => {
    const s = new THREE.Shape();
    // Slightly irregular silhouette — not perfectly symmetric,
    // narrower waist, sloped shoulders.
    s.moveTo(-0.2, 0);
    s.lineTo(0.22, 0);
    s.lineTo(0.19, 0.55);
    s.lineTo(0.23, 1.0);
    s.lineTo(0.2, 1.35);
    s.lineTo(0.13, 1.46);
    s.absarc(0.01, 1.57, 0.125, -0.3, Math.PI + 0.4, false);
    s.lineTo(-0.2, 1.35);
    s.lineTo(-0.22, 1.0);
    s.lineTo(-0.17, 0.55);
    s.lineTo(-0.2, 0);
    return s;
  }, []);

  const state = useRef({
    walking: false,
    walkStart: 0,
    walkDuration: 9,
    nextWalkAt: 12 + Math.random() * 10, // first appearance 12-22s in
    direction: Math.random() > 0.5 ? 1 : -1,
    speedJitter: 0,
  });

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    const s = state.current;

    if (!s.walking && t >= s.nextWalkAt) {
      s.walking = true;
      s.walkStart = t;
      s.walkDuration = 7 + Math.random() * 5; // 7–12s per crossing
      s.direction *= -1;
      s.speedJitter = Math.random() * 6.28;
    }

    if (s.walking) {
      const raw = (t - s.walkStart) / s.walkDuration;
      if (raw >= 1) {
        s.walking = false;
        s.nextWalkAt = t + 28 + Math.random() * 45; // 28-73s until next
        groupRef.current.visible = false;
        return;
      }
      // easeInOutCubic — he starts slow, picks up, slows again
      const e =
        raw < 0.5
          ? 4 * raw * raw * raw
          : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      // Add a slight non-monotonic drift so the pace isn't perfectly
      // measured — feels more like someone walking, not a sprite
      // scrolling.
      const drift = Math.sin(raw * Math.PI * 3 + s.speedJitter) * 0.02;
      const p = Math.min(1, Math.max(0, e + drift));

      groupRef.current.visible = true;
      const xStart = s.direction > 0 ? -5.8 : 5.8;
      const xEnd = -xStart;
      groupRef.current.position.x = THREE.MathUtils.lerp(xStart, xEnd, p);
      // Step bob — frequency tied to progress so bob slows with pace
      const dp = Math.abs(Math.cos(raw * Math.PI)); // near 0 at ends
      groupRef.current.position.y =
        0.005 + Math.sin(raw * Math.PI * 7) * 0.022 * dp;
      // Tiny torso sway
      groupRef.current.rotation.z = Math.sin(raw * Math.PI * 7) * 0.025 * dp;
      const fade = Math.min(raw * 4, (1 - raw) * 4, 1);
      if (matRef.current) matRef.current.opacity = 0.86 * fade;
    }
  });

  return (
    <group ref={groupRef} position={[0, 0, -10.55]} visible={false}>
      <mesh>
        <shapeGeometry args={[figShape]} />
        <meshBasicMaterial
          ref={matRef}
          color="#080202"
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// ————— side wall RectAreaLight —————
// Two rectangular area lights aimed inward from the side walls,
// sitting just behind the velvet wall curtains. Soft amber wash,
// no visible fixture geometry — the curtain fabric is the source.

function WallCurtainLights() {
  return (
    <group>
      {/* Left wall — near stage */}
      <rectAreaLight position={[-10.5, 3.2, -11.5]} rotation={[0,  Math.PI / 2, 0]} width={3} height={5} color="#e8960a" intensity={2} />
      {/* Left wall — second block */}
      <rectAreaLight position={[-10.5, 3.2, -7.0]} rotation={[0,  Math.PI / 2, 0]} width={3} height={5} color="#e8960a" intensity={2} />
      {/* Right wall — near stage */}
      <rectAreaLight position={[10.5,  3.2, -11.5]} rotation={[0, -Math.PI / 2, 0]} width={3} height={5} color="#e8960a" intensity={2} />
      {/* Right wall — second block */}
      <rectAreaLight position={[10.5,  3.2, -7.0]} rotation={[0, -Math.PI / 2, 0]} width={3} height={5} color="#e8960a" intensity={2} />
    </group>
  );
}

// ————— single raven fly-by —————
// Thriller spectacle, not decoration. The raven is a rare event — the
// room goes quiet, then one bird appears with deliberate intent,
// pauses briefly to be seen, then commits to a near-miss dive past
// the lens. Much longer dwell between flights (30–60s) so each
// appearance feels like an apparition, not a bird feeder.
//
// Model: three.js official Parrot.glb (mrdoob, CC0) — chosen over
// the Sketchfab Crow.glb because the Crow's single 10.5s "TakeOff"
// clip contained only ~3s of actual flapping buried in 7s of idle
// pose. The Parrot ships with a clean 1.2s seamless flight loop
// (morph-target animated, not skinned) which is exactly what this
// scene needs. Every mesh's original material is mutated in place
// (color → near-black, texture → null, slight metalness for feather
// sheen) — NOT replaced, because a fresh MeshStandardMaterial lacks
// the morph-target compile-time uniforms and the wings render wrong.
//
// Flight choreography (current design):
//   1. Monotonic back-to-front. Z decreases steadily across the
//      whole curve; the only arc is a gentle one in x and y, never
//      a reversal. Corvids don't hover, loop, or detour.
//   2. Two routes only: LEVEL_GLIDE (most common, eye-level sweep
//      with a small arc) and DESCENDING_ATTACK (rarer, enters high
//      and descends onto the lens).
//   3. Near-pass at z=5.5 world — 0.5m from the lens. With bird
//      at 0.7m longest dimension that's ~80° angular size, larger
//      than the 55° vertical fov; the bird overflows the frame at
//      peak for a single-frame-window flash, then is gone.
//   4. Easing: linear cruise for first 47.5% of flight, then pow-3
//      acceleration through the final 52.5%. The cubic tail
//      compresses post-near-pass time to ≈0.4s — user requirement:
//      "只有一瞬".
//   5. Duration 4.3–5.6s total (tight — strike, not tour). The
//      approach phase is 35% faster than the strike phase would
//      naturally imply: ACCEL_START pulled back from 0.55 to 0.475
//      so time-to-commit shortens from ~3.2s to ~2.35s, matching
//      the user's "faster from far" note.
//   6. Wingbeat: steady 0.5× cruise, ramping cubically to 1.8× during
//      the commit. Matches the body's acceleration into the lens.
//
// Layout reference: camera at (0, 1.65, 6) fov 55° looking at
// (0, 3, -13). All coordinates are world-space.

function RavenFlyBy() {
  const groupRef = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF("/Parrot.glb");

  // Clone per-instance so our tint + animation state don't bleed
  // into any other consumer of /Parrot.glb (there is none today, but
  // this keeps the component self-contained).
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const { actions } = useAnimations(animations, cloned);

  // Tint all meshes to raven-black. Slight metalness (0.15) + mid
  // roughness (0.45) makes the silhouette readable against the dark
  // Red Room — the amber sconces and red hemisphere pick out the
  // wing silhouettes as a thin rim highlight without turning the
  // bird into an identifiable colour. #050505 is near-pure black so
  // scene lighting, not the texture, drives its apparent warmth.
  // Mutate existing materials rather than replacing them. Parrot.glb
  // uses morph-target animation (vertex blend shapes), and three.js
  // needs the material instance to have been initialised with morph-
  // target uniforms at compile time. A freshly-minted
  // MeshStandardMaterial lacks those compile-time setup hooks and
  // the whole mesh renders at bind pose but with weird wing-scaling
  // artefacts. Keeping the original material, just zeroing its color
  // and killing the texture, preserves the morph-target wiring.
  useEffect(() => {
    cloned.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mat) => {
        const std = mat as THREE.MeshStandardMaterial;
        if (!std) return;
        std.color = new THREE.Color("#050505");
        std.map = null;
        std.emissive = new THREE.Color("#000000");
        std.roughness = 0.45;
        std.metalness = 0.15;
        std.needsUpdate = true;
      });
    });
  }, [cloned]);

  // Play the one included clip on loop. Parrot.glb only has
  // `parrot_A_` (1.2s flight cycle), so we grab whatever key exists.
  const flapAction = useRef<THREE.AnimationAction | null>(null);
  useEffect(() => {
    const key = Object.keys(actions)[0];
    if (!key) return;
    const action = actions[key]!;
    action.setLoop(THREE.LoopRepeat, Infinity);
    // 0.5× timeScale pulls wingbeat from ~5 Hz to ~2.5 Hz — closer
    // to a real raven's leisurely wingbeat than the native parrot
    // speed, without looking like a slow-motion effect.
    action.timeScale = 0.5;
    action.play();
    flapAction.current = action;
  }, [actions]);

  // Auto-fit longest dimension to 0.7m. Parrot.glb's native bind-pose
  // bounds are (79.5, 33.7, 100.5) from gltf-transform inspect, so
  // scale ≈ 0.007. Done at mount once the scene is loaded.
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(cloned);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      cloned.scale.setScalar(0.7 / maxDim);
    }
  }, [cloned]);

  const posVec = useRef(new THREE.Vector3()).current;
  const tanVec = useRef(new THREE.Vector3()).current;
  const lookVec = useRef(new THREE.Vector3()).current;
  const lastGoodLook = useRef(new THREE.Vector3(0, 0, 6));

  const state = useRef({
    flying: false,
    startTime: 0,
    duration: 7.5,
    nextFlightAt: 10 + Math.random() * 10, // first appearance 10–20s in
    curve: null as THREE.CatmullRomCurve3 | null,
  });

  // Two hand-authored routes. Both are strictly back→front (z
  // monotonically increases from ≈ -15 to ≈ +7) with only gentle
  // arcs in x and y. Control points are spaced ~4m apart in z so
  // the CatmullRom curve has enough samples for a smooth path but
  // no opportunity to loop or reverse.
  //
  // Small random jitter on non-critical points so repeat flights
  // aren't bit-identical, but the character of each route is fixed.
  type Route = {
    name: string;
    pts: () => THREE.Vector3[];
  };
  const routes: Route[] = useMemo(() => {
    const jitter = (v: number, amt = 0.3) =>
      v + (Math.random() - 0.5) * 2 * amt;
    return [
      {
        // ROUTE_LEVEL_GLIDE: the default. Enters at eye-level from
        // the back of the hall with a small horizontal offset, glides
        // forward in a gentle sinuous arc (x drifts by ~1–2m over the
        // flight, y drops a touch then pulls up at the exit), passes
        // close to the lens at z=5, exits just behind. Feels like a
        // raven sailing through on a straight line — no ambition, no
        // hover, just crossing the room.
        name: "level-glide",
        pts: () => {
          // Pick an entry side so the arc reads as deliberate instead
          // of random. Enter ±2.5m off-axis, drift toward centre.
          const side = Math.random() < 0.5 ? -1 : 1;
          const entryX = jitter(2.5 * side, 0.6);
          const midX = jitter(1.2 * side, 0.4);   // still biased but tightening
          const nearX = jitter(0, 0.25);          // near dead-centre at the lens
          const exitX = jitter(-0.4 * side, 0.3); // drifts past centre at exit
          return [
            new THREE.Vector3(entryX, jitter(3.0, 0.3), -15), // entry high-back
            new THREE.Vector3(midX, jitter(2.7, 0.2), -9),    // gentle descent
            new THREE.Vector3(midX * 0.5, jitter(2.3, 0.2), -3), // level out
            new THREE.Vector3(nearX, jitter(1.8, 0.08), 5.5), // NEAR PASS — 0.5m from lens
            new THREE.Vector3(exitX, jitter(2.3, 0.2), 6.6),  // exit just 0.6m behind camera
          ];
        },
      },
      {
        // ROUTE_DESCENDING_ATTACK: rarer. Enters higher (y≈6) and
        // drops steadily toward the lens. Same monotonic-z structure
        // as LEVEL_GLIDE but with a bigger altitude delta and a
        // closer near-pass. Reads as "spotted something, committing
        // to a stoop" rather than a casual pass.
        name: "descending",
        pts: () => {
          const side = Math.random() < 0.5 ? -1 : 1;
          const entryX = jitter(2 * side, 0.5);
          return [
            new THREE.Vector3(entryX, jitter(6.0, 0.4), -14),    // entry high
            new THREE.Vector3(entryX * 0.6, jitter(4.2, 0.3), -8), // descent
            new THREE.Vector3(entryX * 0.2, jitter(2.5, 0.2), -2), // level out low
            new THREE.Vector3(jitter(0, 0.15), jitter(1.65, 0.08), 5.5), // NEAR PASS — 0.5m from lens
            new THREE.Vector3(jitter(-0.3 * side, 0.25), jitter(3.0, 0.25), 6.6), // exit 0.6m past camera
          ];
        },
      },
    ];
  }, []);

  const generatePath = () => {
    // 70% level glide, 30% descending attack. The glide is the
    // "signature" pass; the attack is the dramatic variant.
    const chosen = Math.random() < 0.7 ? routes[0] : routes[1];
    return new THREE.CatmullRomCurve3(chosen.pts());
  };

  // Easing: linear for the first 47.5% of flight (natural cruise),
  // then cubic (pow-3) acceleration for the last 52.5% so the bird
  // grows into the lens and is gone within ~0.4s of the near-pass.
  //
  //   raw 0..0.475 → curve param 0.00..0.50 (linear cruise)
  //   raw 0.475..1.00 → curve param 0.50..1.00 (pow-3 accel)
  //
  // ACCEL_START moved 0.55 → 0.475 and duration dropped 5–6.5s →
  // 4.3–5.6s so the APPROACH phase (raw 0..0.475, curve 0..0.5) is
  // ~35% faster in world-speed while the strike phase stays the same
  // ~2.6s. Math:
  //   approach_time = ACCEL_START × duration
  //     old: 0.55 × 5.75 ≈ 3.16s (mean)
  //     new: 0.475 × 4.95 ≈ 2.35s (mean), 3.16/2.35 ≈ 1.35×
  //   strike_time = (1 - ACCEL_START) × duration
  //     old: 0.45 × 5.75 ≈ 2.59s
  //     new: 0.525 × 4.95 ≈ 2.60s (unchanged)
  //
  // With 5 control points (segments of 0.25 curve param each):
  //   - Near-pass sits at curve param 0.75 (point 3 of 4 segments)
  //   - Under pow-3 accel that's reached at raw ≈ 0.92
  //   - Exit at raw 1.0 → 0.08 × 5s ≈ 0.4s from near-pass to gone.
  const ACCEL_START = 0.475;
  const ACCEL_CURVE_AT_START = 0.50;
  const curveParamForTime = (raw: number): number => {
    if (raw < ACCEL_START) {
      // Linear cruise
      return (raw / ACCEL_START) * ACCEL_CURVE_AT_START;
    }
    // Cubic accelerate for the commit — harder than pow-2; more of
    // the post-pause curve lives in the final sprint.
    const local = (raw - ACCEL_START) / (1 - ACCEL_START);
    const accel = local * local * local;
    return ACCEL_CURVE_AT_START + accel * (1 - ACCEL_CURVE_AT_START);
  };

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    const s = state.current;

    if (!s.flying && t >= s.nextFlightAt) {
      s.flying = true;
      s.startTime = t;
      s.duration = 4.3 + Math.random() * 1.3; // 4.3–5.6s per flight — approach 35% faster, strike unchanged
      s.curve = generatePath();
      if (flapAction.current) {
        flapAction.current.play();
        flapAction.current.timeScale = 0.5;
      }
    }

    if (!s.flying || !s.curve) {
      groupRef.current.visible = false;
      return;
    }

    const raw = (t - s.startTime) / s.duration;
    if (raw >= 1) {
      s.flying = false;
      // Long dwell so each flight feels rare. Combined with 6.5–8s
      // per flight, a raven is onscreen ~15–20% of the time.
      s.nextFlightAt = t + 30 + Math.random() * 30; // 30–60s dwell
      groupRef.current.visible = false;
      s.curve = null;
      return;
    }

    const p = curveParamForTime(raw);

    // Wingbeat: steady cruise at 0.5× through the approach, ramps up
    // cubically to 1.8× during the commit — urgent downstroke as the
    // body rockets toward the lens, matches the pow-3 position curve.
    if (flapAction.current) {
      if (raw < ACCEL_START) {
        flapAction.current.timeScale = 0.5;
      } else {
        const local = (raw - ACCEL_START) / (1 - ACCEL_START);
        flapAction.current.timeScale = 0.5 + 1.3 * local * local * local;
      }
    }

    s.curve.getPoint(p, posVec);
    s.curve.getTangent(p, tanVec);

    groupRef.current.visible = true;
    groupRef.current.position.copy(posVec);

    // LookAt via tangent. Keep last stable direction if tangent is
    // near-zero (belt-and-suspenders — no hover anymore but cheap
    // insurance).
    if (tanVec.lengthSq() > 1e-4) {
      lastGoodLook.current.copy(tanVec).normalize();
    }
    lookVec.copy(posVec).add(lastGoodLook.current);
    groupRef.current.lookAt(lookVec);
  });

  return (
    <group ref={groupRef} visible={false}>
      <primitive object={cloned} />
    </group>
  );
}

useGLTF.preload("/Parrot.glb");

// ————— background flock —————
// A small, slow drift of cream triangle-birds in the back half of the
// room — a distant "vision" layer behind the single white stork's
// thriller dive. Visible above the stage, dense enough to read as a
// flock, sparse and slow enough to feel like a dream texture.
//
// Ported (with author jtrdev's permission) from his CodePen pen
// yLVJogz — itself a modernization of mrdoob's r51 canvas_geometry_
// birds example. The boid math is 1:1 with the original; the
// rewrite is modernization-only:
//   • THREE.Geometry/Face3 → BufferGeometry + indexed attributes,
//   • addSelf / subSelf / divideScalar(l/n) → modern .add / .sub
//     / .multiplyScalar(1/n),
//   • CanvasRenderer → our existing WebGL renderer,
//   • world scaled from ±500 units to ±(4, 2, 3.5) room units so the
//     flock lives behind the stage instead of in open sky,
//   • 200 birds → 32 (dense enough for flock read, easy at 60fps).
//
// The flock is placed via <group position={[0, 6, -10.5]}> behind
// and above the stage, so boids orbit above head height and recede
// into the curtain — they never collide with the camera or the
// stork's dive corridor.

// Simple triangle-bird geometry — three tris forming a body + two
// wings. Vertices 4 and 5 are the wingtips; a per-vertex `aWing`
// mask flags them so the vertex shader can displace y for the flap.
function makeBirdGeo() {
  const s = 0.035; // overall scale — bird ~0.35m long
  const verts = new Float32Array([
    5 * s, 0, 0,
    -5 * s, -2 * s, 1 * s,
    -5 * s, 0, 0,
    -5 * s, -2 * s, -1 * s,
    0, 2 * s, -6 * s, // wingtip -z
    0, 2 * s, 6 * s,  // wingtip +z
    2 * s, 0, 0,
    -3 * s, 0, 0,
  ]);
  const wing = new Float32Array([0, 0, 0, 0, 1, 1, 0, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  g.setAttribute("aWing", new THREE.BufferAttribute(wing, 1));
  g.setIndex([0, 2, 1, 4, 7, 6, 5, 6, 7]);
  g.computeVertexNormals();
  return g;
}
const BIRD_WING_SCALE = 0.035 * 5; // see makeBirdGeo: wingtip y swings ±5s

// Reynolds boid with wall-avoidance. State is per-instance; every
// frame each boid reads the full flock to compute alignment,
// cohesion, separation. The Math.random() > 0.6 skip in each loop
// is intentional — it's straight from the original and gives the
// flock a slightly twitchy, non-uniform read instead of a
// perfectly-coordinated one.
class Boid {
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  phase = Math.random() * 62.83;
  private accel = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  // Room (world): side curtains at x=±11, back curtain at z=-16,
  // ceiling ~y=9, floor y=0. Flock renders inside a group at
  // GROUP_POS (0, 5, -3), so the box below is LOCAL to that group.
  //
  // Sized to stay fully INSIDE the curtains (1m margin) so the soft
  // wall-avoid force never has to overcome momentum across a curtain
  // plane. Previous values (14, 5, 16) put the box 3m past the side
  // and back curtains — birds visibly penetrated them.
  //
  //   worldHalf (10, 4.5, 12) → volume 4320 (down from 8960)
  //   density 60/4320 = 0.0139 per unit³ (2× old)
  //   neighbors at radius 6: 0.0139 × (4/3 π 216) × 0.6 ≈ 7.5
  //   active — close to the previous 5.7, keeps flocking quality.
  worldHalf = new THREE.Vector3(10, 4.5, 12);
  // Radius dropped from 8.0 → 6.0 to keep active-neighbor count in
  // the flocking sweet spot (5–10) after the density doubled from
  // the box shrink. Above 15 birds cluster into a blob; below 3 they
  // scatter independently. 6.0 puts us around 7.5.
  neighborhoodRadius = 6.0;
  maxSpeed = 0.12;
  // 50:1 ratio of maxSpeed:maxSteerForce matches the pen and gives
  // the gentle-arc feel — steering takes many frames to redirect
  // velocity, so turns draw smooth curves instead of snapping.
  maxSteerForce = 0.0024;
  goal: THREE.Vector3 | null = null;
  avoidWalls = true;
  // Per-frame goal pull strength. Default matches the original pen
  // (0.0005) — gentle enough that cohesion/alignment still shape
  // flock character. Flock raises this to ~0.002 during hide
  // transits so the group gets offscreen quickly instead of
  // meandering across frame.
  goalMultiplier = 0.0005;

  run(flock: Boid[]) {
    if (this.avoidWalls) {
      this.addAvoid(-this.worldHalf.x, this.position.y, this.position.z);
      this.addAvoid(this.worldHalf.x, this.position.y, this.position.z);
      this.addAvoid(this.position.x, -this.worldHalf.y, this.position.z);
      this.addAvoid(this.position.x, this.worldHalf.y, this.position.z);
      this.addAvoid(this.position.x, this.position.y, -this.worldHalf.z);
      this.addAvoid(this.position.x, this.position.y, this.worldHalf.z);
    }
    if (Math.random() > 0.5) this.doFlock(flock);
    this.move();
    // Hard-clamp as a safety net AFTER the physics step. The soft
    // addAvoid forces handle 99% of cases, but cohesion can pull a
    // bird slightly past a wall before avoid catches up, and the
    // avoid's sign is wrong for birds already outside the box (it
    // pushes them further out). The clamp guarantees no curtain can
    // ever be penetrated, no matter how the flocking forces align.
    this.clampToRoom();
  }

  // Enforce the room as a hard boundary. Called every frame after
  // move(). In addition to the axis-aligned bounds encoded in
  // worldHalf, a second forbidden region is carved out for the stage
  // enclosure — birds shouldn't enter the volume behind the closed
  // stage curtain (the red pleated drape on the proscenium).
  //
  // All coordinates here are LOCAL to the flock group (GROUP_POS at
  // (0, 5, -3) world). World→local offsets for the stage geometry:
  //   world back curtain z=-16 → local -13 (covered by worldHalf.z=12)
  //   world side curtains x=±11 → local ±11 (covered by worldHalf.x=10)
  //   world stage closed curtain z=-10.75 → local -7.75
  //   world stage aperture x∈[-6.5, 6.5], y∈[1.5, 7.5]
  //     → local x∈[-6.5, 6.5], y∈[-3.5, 2.5]
  private clampToRoom() {
    // Axis-aligned room bounds
    if (this.position.x > this.worldHalf.x) {
      this.position.x = this.worldHalf.x;
      if (this.velocity.x > 0) this.velocity.x = 0;
    } else if (this.position.x < -this.worldHalf.x) {
      this.position.x = -this.worldHalf.x;
      if (this.velocity.x < 0) this.velocity.x = 0;
    }
    if (this.position.y > this.worldHalf.y) {
      this.position.y = this.worldHalf.y;
      if (this.velocity.y > 0) this.velocity.y = 0;
    } else if (this.position.y < -this.worldHalf.y) {
      this.position.y = -this.worldHalf.y;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
    if (this.position.z > this.worldHalf.z) {
      this.position.z = this.worldHalf.z;
      if (this.velocity.z > 0) this.velocity.z = 0;
    } else if (this.position.z < -this.worldHalf.z) {
      this.position.z = -this.worldHalf.z;
      if (this.velocity.z < 0) this.velocity.z = 0;
    }

    // Stage closed curtain: the pleated drape at world z=-10.75 is
    // only a wall within the stage aperture. Birds flying above it
    // (y > 2.5 local / 7.5 world) pass safely over; birds flying off
    // to the sides of it pass around. But if a bird is in the
    // aperture, it cannot cross z < -7.75 local.
    const inStageAperture =
      Math.abs(this.position.x) < 6.5 &&
      this.position.y > -3.5 &&
      this.position.y < 2.5;
    if (inStageAperture && this.position.z < -7.75) {
      this.position.z = -7.75;
      if (this.velocity.z < 0) this.velocity.z = 0;
    }
  }

  private addAvoid(x: number, y: number, z: number) {
    this.tmp.set(x, y, z);
    const dsq = this.position.distanceToSquared(this.tmp);
    if (dsq < 1e-6) return;
    const steer = new THREE.Vector3().copy(this.position).sub(this.tmp);
    // Original pen uses constant 5 against worldHalf=500, maxSpeed=5.
    // At wall distance d, force magnitude = 5/d. Near the wall (d=50)
    // that's 0.1 — 2% of maxSpeed. Gentle turn, not bumper.
    //
    // Softer wall-avoid so the flock can actually graze the edges of
    // the box and linger in the deep corners instead of being held
    // off from d=5. Constant 0.02 gives 0.02/d: at d=1 that's 17% of
    // maxSpeed (still firm enough to prevent penetration), at d=2
    // it's 8% — gentle enough that a goal pull toward the corner
    // can overpower it over time.
    steer.multiplyScalar(0.02 / dsq);
    this.accel.add(steer);
  }

  private doFlock(flock: Boid[]) {
    if (this.goal) {
      // Goal multiplier scaled to our maxSpeed (0.12) rather than
      // the pen's (5). At d=10 this gives a 0.005 nudge — same order
      // as maxSteerForce — so it biases flock direction over many
      // frames without overpowering alignment/cohesion on any
      // single frame. Roaming the goal produces long elegant arcs
      // as the flock leans slowly toward each new waypoint.
      const steer = new THREE.Vector3()
        .copy(this.goal)
        .sub(this.position)
        .multiplyScalar(this.goalMultiplier);
      this.accel.add(steer);
    }
    this.accel.add(this.alignment(flock));
    this.accel.add(this.cohesion(flock));
    this.accel.add(this.separation(flock));
  }

  private move() {
    this.velocity.add(this.accel);
    const l = this.velocity.length();
    if (l > this.maxSpeed) this.velocity.multiplyScalar(this.maxSpeed / l);
    this.position.add(this.velocity);
    this.accel.set(0, 0, 0);
  }

  private alignment(flock: Boid[]) {
    const velSum = new THREE.Vector3();
    let count = 0;
    for (let i = 0; i < flock.length; i++) {
      if (Math.random() > 0.6) continue;
      const other = flock[i];
      const d = other.position.distanceTo(this.position);
      if (d > 0 && d <= this.neighborhoodRadius) {
        velSum.add(other.velocity);
        count++;
      }
    }
    if (count > 0) {
      velSum.divideScalar(count);
      const l = velSum.length();
      if (l > this.maxSteerForce) velSum.multiplyScalar(this.maxSteerForce / l);
    }
    return velSum;
  }

  private cohesion(flock: Boid[]) {
    const posSum = new THREE.Vector3();
    let count = 0;
    for (let i = 0; i < flock.length; i++) {
      if (Math.random() > 0.6) continue;
      const other = flock[i];
      const d = other.position.distanceTo(this.position);
      if (d > 0 && d <= this.neighborhoodRadius) {
        posSum.add(other.position);
        count++;
      }
    }
    // When no neighbors are in range (count === 0), return zero
    // steer. The original pen falls through to steer = -position
    // here, which gives an implicit "pull toward origin" for
    // stragglers. In the pen that branch almost never triggered (200
    // dense birds, everyone has neighbors); in our sparser port it
    // triggers constantly and pulls isolated birds toward the
    // flock's local origin — which maps to mid-hall height in world
    // coords and produces a blob of birds clustering near the
    // ceiling. Disabling the implicit origin-pull lets true flocking
    // behavior emerge from alignment + real cohesion only.
    if (count === 0) return new THREE.Vector3();
    posSum.divideScalar(count);
    const steer = new THREE.Vector3().copy(posSum).sub(this.position);
    const l = steer.length();
    if (l > this.maxSteerForce) steer.multiplyScalar(this.maxSteerForce / l);
    return steer;
  }

  private separation(flock: Boid[]) {
    const posSum = new THREE.Vector3();
    const repulse = new THREE.Vector3();
    for (let i = 0; i < flock.length; i++) {
      if (Math.random() > 0.6) continue;
      const other = flock[i];
      const d = other.position.distanceTo(this.position);
      if (d > 0 && d <= this.neighborhoodRadius) {
        repulse.copy(this.position).sub(other.position).normalize();
        repulse.divideScalar(d);
        posSum.add(repulse);
      }
    }
    // Cap separation the same way alignment/cohesion are capped.
    // The original pen deliberately left this uncapped because in
    // its density (d ~ 50 in a ±500 world) each contribution is 1/50
    // ≈ 0.02 and ~5 neighbors sum to ≈ 0.1, right at maxSteerForce
    // naturally. Our port has d ~ 2 in a ±8 world, so each
    // contribution is ~1/2 = 0.5 and the raw magnitude is ~1000×
    // maxSteerForce. Uncapped, separation clamps velocity every
    // frame to its own direction, overwhelming alignment/cohesion
    // and making each bird "spin in place" as close neighbors flip
    // the push-away direction tick to tick.
    // Cap at 2.5× maxSteerForce. 4× (when neighborhood was small)
    // was needed to get dispersal at all — at r=5 most neighbors
    // were invisible, so locally-dense encounters were rare and
    // needed to fire hard. With r=8 and ~5.7 active neighbors,
    // dispersal triggers more often on its own, and 4× started
    // winning every close encounter 4:1 over cohesion — which is
    // why the flock felt strung out. 2.5× keeps the disperse-beat
    // visible but lets cohesion reel the flock back together.
    const l = posSum.length();
    const cap = this.maxSteerForce * 2.5;
    if (l > cap) posSum.multiplyScalar(cap / l);
    return posSum;
  }
}

function Flock() {
  const NUM = 40;

  const boids = useMemo(() => {
    const list: Boid[] = [];
    for (let i = 0; i < NUM; i++) {
      const b = new Boid();
      // Spawn in the central 40% of the box (matching the original
      // pen which spawns in ±200 inside a ±500 world). Uniform-across-
      // box spawning put birds at the corners and they collapsed
      // toward the center as the first visible behavior, which read
      // as "birds gathering at the ceiling" rather than flying.
      const SPAWN = 0.4;
      b.position.set(
        (Math.random() - 0.5) * 2 * b.worldHalf.x * SPAWN,
        (Math.random() - 0.5) * 2 * b.worldHalf.y * SPAWN,
        (Math.random() - 0.5) * 2 * b.worldHalf.z * SPAWN,
      );
      // Seed with ~20% of maxSpeed (matching the pen: velocity ±1
      // against maxSpeed 5). Previously I seeded at full maxSpeed,
      // which made the flock look like a shotgun blast on frame 0.
      const V0 = b.maxSpeed * 0.2;
      b.velocity.set(
        (Math.random() - 0.5) * 2 * V0,
        (Math.random() - 0.5) * 2 * V0,
        (Math.random() - 0.5) * 2 * V0,
      );
      list.push(b);
    }
    return list;
  }, []);

  // ONE shared geometry + ONE InstancedMesh for all NUM birds — a
  // single draw call, not 40. The wing flap runs in the vertex shader
  // (see `material` below), driven per-bird by an InstancedBuffer-
  // Attribute `aPhase` that we update on CPU each frame. This keeps
  // the original pitch-coupled flap rate exactly (the flap rate
  // depends on each bird's pitch, so the phase advance stays on the
  // CPU alongside boid physics) while avoiding 40 separate geometry
  // uploads per frame — we upload 40 floats instead of 40 meshes'
  // worth of vertex data.
  const geometry = useMemo(() => makeBirdGeo(), []);

  const phaseAttr = useMemo(() => {
    const arr = new Float32Array(NUM);
    const a = new THREE.InstancedBufferAttribute(arr, 1);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  }, [NUM]);

  // Attach the per-instance phase to the shared geometry so the
  // vertex shader can read it (the `attribute float aPhase;` below).
  useEffect(() => {
    geometry.setAttribute("aPhase", phaseAttr);
  }, [geometry, phaseAttr]);

  // Boid material: MeshStandardMaterial + DoubleSide (unchanged from
  // the per-mesh version — no visual downgrade). onBeforeCompile adds
  // the wing-flap displacement: for each vertex, mix the base y with
  // sin(aPhase) * flapScale using the aWing mask (0 for body, 1 for
  // wingtips). This matches the old CPU code's `pos.setY(4, flap)` /
  // `pos.setY(5, flap)` exactly — it REPLACES the base y on wingtips
  // rather than adding to it.
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#1a0d08"),
      roughness: 0.5,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uFlapScale = { value: BIRD_WING_SCALE };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
           attribute float aPhase;
           attribute float aWing;
           uniform float uFlapScale;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
           transformed.y = mix(transformed.y, sin(aPhase) * uFlapScale, aWing);`,
        );
    };
    return m;
  }, []);

  const instancedRef = useRef<THREE.InstancedMesh>(null);
  const tmpObj = useMemo(() => new THREE.Object3D(), []);

  // Roaming goal — a waypoint the whole flock slowly steers toward.
  // Two structures drive the flock's motion:
  //   - hideouts: single-point offscreen destinations (10 points,
  //     picked via side-alternating Fisher-Yates bag below).
  //   - routes:   multi-point dramatic flight paths (8 routes,
  //     each 3 sub-points with 1.5–2s dwells; see the routes
  //     definition further down).
  //
  // Cadence: hide dwell 12–18s (whole hideout), show duration
  // ≈ 5s (route total = sum of sub-point dwells). 15% chance of
  // hide→hide instead of strict alternation adds an occasional
  // extra-long absence without letting it dominate.
  //
  // Math: per ~20s cycle, ~2s of hide dwell is still-visible transit
  // (flock leaving frame under the boosted goal pull), the rest is
  // truly offscreen:
  //   visible = route_duration + leaving_transit ≈ 5 + 2 = 7s
  //   hidden  = hide_dwell − leaving_transit ≈ 15 − 2 = 13s
  //   → ~35% visible, ~65% offscreen.
  //
  // Hideouts sit just inside the box edges (wall-avoid prevents
  // reaching them exactly, but d=1–2 from the wall is enough to
  // keep the flock outside the camera frustum). Shows sit inside
  // the visible stage area — the flock passes THROUGH frame on its
  // way to each show waypoint, then transits back out again.
  //
  // During hide transits, goalMultiplier is boosted from 0.0005 to
  // 0.002 — the flock commits to leaving frame instead of meandering
  // across it. During show, it drops back so the flock lingers in
  // the visible area rather than rocketing straight through.
  //
  // Waypoints are in WORLD coords; converted to local by subtracting
  // the <group> position.
  const GROUP_POS = useMemo(() => new THREE.Vector3(0, 5, -3), []);
  const { hideouts } = useMemo(() => {
    const toLocal = (wx: number, wy: number, wz: number) => ({
      local: new THREE.Vector3(wx - GROUP_POS.x, wy - GROUP_POS.y, wz - GROUP_POS.z),
    });
    return {
      // 10 hideouts, varied enough that the flock genuinely feels
      // like it could be anywhere off-frame. All inside the tighter
      // flock box (x ∈ [-10, 10], z ∈ [-15, 9] world) AND reliably
      // outside the fov 55° frustum on BOTH portrait and landscape:
      //   - z > camera.z (=6) puts the bird behind the camera —
      //     the most robust offscreen test, works any aspect.
      //   - |x| ≥ 9 at z=-3 (distance 9 from camera): landscape
      //     horizontal half-width ≈ 7.5 → 1.5m margin outside frame.
      //   - y very low (~1) or high (~8) at mid-z often falls out
      //     of the vertical frustum too, adding another axis.
      // Dwell is randomised at pick time (not stored here) — the
      // same waypoint may be held 25s one visit and 35s the next,
      // making cadence itself unpredictable.
      hideouts: [
        toLocal(0, 8, 7),          // behind camera, high center
        toLocal(0, 1, 7),          // behind camera, low center
        toLocal(8, 5, 7),          // behind camera, slight right
        toLocal(-8, 5, 7),         // behind camera, slight left
        toLocal(4, 8, 7),          // behind camera, upper-right (new)
        toLocal(-4, 8, 7),         // behind camera, upper-left (new)
        toLocal(9.5, 8, -3),       // far-right wall, high
        toLocal(-9.5, 8, -3),      // far-left wall, high
        toLocal(9.5, 3, 3),        // far-right wall, mid (new)
        toLocal(-9.5, 3, 3),       // far-left wall, mid (new)
      ],
    };
  }, [GROUP_POS]);

  // ————— Dramatic routes (continuous curve-driven flight paths) —————
  // Previous design (multi-point dwell): every 1.5–2s the goal
  // teleported to a new sub-point. With goalMultiplier=0.0005 during
  // show, the flock applied only ~2% of maxSpeed toward the target
  // per frame — nowhere near enough to actually reach a sub-point
  // before the goal jumped again. Result: flock swirled in a tight
  // 3-way tug-of-war between nearby sub-points, never escaping that
  // small zone. User complained (correctly) that the flock was
  // "circling in a small area".
  //
  // New design: each route is a CatmullRom curve built from 5
  // control points, and the goal SMOOTHLY TRACKS a point sliding
  // along that curve. Every frame, `goal = curve.getPoint(elapsed /
  // duration)`. The goal is always moving — at ~2.5 m/s (curve
  // length ÷ duration, slower than flock maxSpeed of 7.2 m/s) — so
  // the flock can and does follow it like a tail behind a kite.
  // This forces the flock to actually traverse the whole curve over
  // the show phase, producing long winding paths instead of
  // stationary clusters.
  //
  // Frame + box constraints (camera at (0, 1.65, 6) fov 55°):
  //   NEAR (z=2–4): |x|≤2, y∈[1.5, 3]
  //   MID  (z=-5 to 0): |x|≤5, y∈[2, 5]
  //   FAR  (z=-10 to -7): |x|≤7, y∈[3, 7]
  //   Stage-aperture (|x|<6.5, y∈[1.5, 7.5], z<-10.75) is forbidden
  //     by the curtain clamp — keep routes out of it. Using z=-10
  //     world as the FAR limit avoids this automatically.
  type Route = {
    name: string;
    curve: THREE.CatmullRomCurve3;
    duration: number; // seconds to traverse the whole curve
  };
  const routes = useMemo<Route[]>(() => {
    const mk = (
      name: string,
      duration: number,
      pts: [number, number, number][],
    ): Route => ({
      name,
      duration,
      curve: new THREE.CatmullRomCurve3(
        pts.map(
          ([wx, wy, wz]) =>
            new THREE.Vector3(
              wx - GROUP_POS.x,
              wy - GROUP_POS.y,
              wz - GROUP_POS.z,
            ),
        ),
        false, // not closed
        "centripetal",
      ),
    });
    // Routes are deliberately placed in 5 different MOTION CATEGORIES
    // so the visible flight character changes between picks. Earlier
    // tuning had 7 of 8 routes starting "far-back" and ending "near-
    // front-low" — different middles but same start+end zones — and
    // the user (rightly) read them as the same trajectory played
    // over and over. The categories below force distinct screen-
    // motion shapes.
    return [
      // Category 1: PURE LATERAL (no depth change) — flock crosses
      // the room horizontally without coming any closer. Reads as
      // "passing through".
      mk("deep-cross-LR", 8, [
        [-9, 5.5, -10], [-4, 6, -10], [0, 6, -10], [4, 5.5, -10], [9, 5, -10],
      ]),
      mk("deep-cross-RL", 8, [
        [9, 5.5, -10], [4, 6, -10], [0, 6, -10], [-4, 5.5, -10], [-9, 5, -10],
      ]),
      mk("mid-cross-LR", 7, [
        [-7, 4, -3], [-3, 4, -3], [0, 4, -3], [3, 4, -3], [7, 4, -3],
      ]),

      // Category 2: PURE VERTICAL — flock falls or climbs in place.
      // No lateral motion, no depth change. Reads as a "column".
      mk("dive-from-high", 6, [
        [0, 8, -7], [0, 6, -7], [0, 4, -7], [0, 2.5, -7], [0, 1.5, -7],
      ]),

      // Category 3: RECEDING into depth (near → far). Flock starts
      // close-ish and disappears into the back of the hall. Opposite
      // direction of the classic "swooping at lens" motion.
      mk("rise-to-back", 7, [
        [-2, 2.5, 2], [-2, 4, -1], [-2, 5.5, -4], [-3, 6.5, -7], [-3, 7, -10],
      ]),
      mk("descend-to-back", 7, [
        [3, 6, 0], [3, 5, -2], [3, 4, -4], [3, 3, -6], [3, 2.5, -8],
      ]),

      // Category 4: APPROACHING the lens — flock comes from far to
      // near. Only ONE route in this category now (was 7 of 8 before).
      mk("near-charge", 5, [
        [0, 6, -10], [0, 5, -6], [0, 4, -3], [0, 3, 0], [0, 2.5, 3.5],
      ]),

      // Category 5: LOCAL ORBITS — short loops in one zone of the
      // room. Flock circles, doesn't traverse the whole space.
      mk("near-skim", 4, [
        [-1.5, 2.5, 3.5], [-0.5, 3, 3.5], [0.5, 3.5, 3.5], [1.5, 3, 3.5], [1.5, 2.5, 3.5],
      ]),
      mk("side-orbit-L", 7, [
        [-7, 5, -8], [-6, 3.5, -5], [-5, 3, -2], [-6, 4, 0], [-7, 5.5, -3],
      ]),
      mk("high-arc", 7, [
        [5, 6, -10], [3, 7, -7], [0, 7.5, -5], [-3, 7, -7], [-5, 6, -10],
      ]),
    ];
  }, [GROUP_POS]);

  // Hideouts are still single-point with side-alternating bags (the
  // off-screen exit direction matters for visual variety, and the
  // bag prevents consecutive-same-hideout streaks that pure random
  // produced). Shows now use the multi-point route system above.
  const hideSrcL = useMemo(() => hideouts.filter((h) => h.local.x <= 0), [hideouts]);
  const hideSrcR = useMemo(() => hideouts.filter((h) => h.local.x >= 0), [hideouts]);

  type WP = { local: THREE.Vector3 };
  const hideBagL = useRef<WP[]>([]);
  const hideBagR = useRef<WP[]>([]);
  const lastHideSide = useRef<"L" | "R">("R");

  // Fisher-Yates refill.
  const shuffleAndRefill = <T,>(bag: React.MutableRefObject<T[]>, source: T[]) => {
    const copy = [...source];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    bag.current = copy;
  };

  const pickAlternating = (
    bagL: React.MutableRefObject<WP[]>,
    bagR: React.MutableRefObject<WP[]>,
    srcL: WP[],
    srcR: WP[],
    lastSide: React.MutableRefObject<"L" | "R">,
  ): WP => {
    const flip = Math.random() < 0.85;
    const side: "L" | "R" = flip
      ? lastSide.current === "L" ? "R" : "L"
      : lastSide.current;
    const bag = side === "L" ? bagL : bagR;
    const source = side === "L" ? srcL : srcR;
    if (bag.current.length === 0) shuffleAndRefill(bag, source);
    const next = bag.current.shift()!;
    lastSide.current = side;
    return next;
  };

  // Route bag: shuffled queue of all routes, refilled when empty.
  // With 10 routes, user sees all 10 dramatic paths before any
  // repeat — over a typical ~20s cycle that's ~3 min for a full
  // tour. lastPickedRoute is used to prevent the bag-boundary
  // repeat (last pick of old bag = first pick of fresh shuffle,
  // which would otherwise happen 1/N of the time).
  const routeBag = useRef<Route[]>([]);
  const lastPickedRoute = useRef<Route | null>(null);
  const pickRoute = (): Route => {
    if (routeBag.current.length === 0) {
      shuffleAndRefill(routeBag, routes);
      // Defend against the bag-boundary repeat: if the freshly-shuffled
      // bag's first item equals the last item we picked from the
      // PREVIOUS bag, swap it with the next item.
      if (
        lastPickedRoute.current &&
        routeBag.current[0] === lastPickedRoute.current &&
        routeBag.current.length > 1
      ) {
        [routeBag.current[0], routeBag.current[1]] = [
          routeBag.current[1],
          routeBag.current[0],
        ];
      }
    }
    const next = routeBag.current.shift()!;
    lastPickedRoute.current = next;
    return next;
  };

  // State. During show, currentRoute holds the active CatmullRom
  // curve and we continuously interpolate `goal` along it each
  // frame. During hide, goal is static at the hideout.
  const initialRoute = routes[0];
  const goal = useRef(initialRoute.curve.getPoint(0, new THREE.Vector3()));
  const currentRoute = useRef<Route | null>(initialRoute);
  const currentDwell = useRef(0); // used only for hide phase now
  const phase = useRef<"hide" | "show">("show");
  const waypointStart = useRef(0);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const elapsed = t - waypointStart.current;
    let shouldTransition = false;

    if (phase.current === "show" && currentRoute.current) {
      const route = currentRoute.current;
      if (elapsed < route.duration) {
        // Slide the goal along the curve, parameterised by elapsed/
        // duration. The flock chases this moving target — never
        // reaching it, always trailing behind — which is how we get
        // long winding travel instead of stationary clusters.
        route.curve.getPoint(elapsed / route.duration, goal.current);
      } else {
        shouldTransition = true;
      }
    } else {
      // Hide phase: goal is static, just wait out the dwell.
      if (elapsed > currentDwell.current) shouldTransition = true;
    }

    if (shouldTransition) {
      waypointStart.current = t;
      // Phase flip:
      //   from show → always hide
      //   from hide → 85% show, 15% another hide
      if (phase.current === "show") {
        phase.current = "hide";
      } else {
        phase.current = Math.random() < 0.85 ? "show" : "hide";
      }

      if (phase.current === "hide") {
        currentRoute.current = null;
        const next = pickAlternating(
          hideBagL, hideBagR, hideSrcL, hideSrcR, lastHideSide,
        );
        currentDwell.current = 12 + Math.random() * 6; // 12–18s offscreen
        goal.current.copy(next.local);
      } else {
        // Start a new curve. Goal at s=0.
        const route = pickRoute();
        currentRoute.current = route;
        route.curve.getPoint(0, goal.current);
      }
    }

    // Stronger goal pull while hiding so the flock commits to leaving
    // the frame instead of drifting across it. During show the goal
    // is continuously MOVING along a curve at ~2.8 m/s, so the flock
    // needs a firmer pull to actually follow it (0.0005 was fine for
    // a static show goal but left the flock too slow to track a
    // sliding target — it would get lapped by the curve and end up
    // never reaching the later waypoints).
    const hideMul = 0.002;
    const showMul = 0.001;
    const activeMul = phase.current === "hide" ? hideMul : showMul;

    const mesh = instancedRef.current;
    if (!mesh) return;
    const phaseArr = phaseAttr.array as Float32Array;
    for (let i = 0; i < boids.length; i++) {
      const b = boids[i];
      b.goal = goal.current;
      b.goalMultiplier = activeMul;
      b.run(boids);

      tmpObj.position.copy(b.position);
      tmpObj.rotation.set(0, Math.atan2(-b.velocity.z, b.velocity.x), 0);
      const speed = b.velocity.length();
      tmpObj.rotation.z = speed > 1e-6 ? Math.asin(b.velocity.y / speed) : 0;
      tmpObj.updateMatrix();
      mesh.setMatrixAt(i, tmpObj.matrix);

      // Flap: shader reads sin(aPhase) * uFlapScale for wingtip
      // vertices. Keep the pen's pitch-coupled advance so climbing
      // birds flap faster, diving birds glide.
      b.phase = (b.phase + Math.max(0, tmpObj.rotation.z) + 0.1) % 62.83;
      phaseArr[i] = b.phase;
    }
    mesh.instanceMatrix.needsUpdate = true;
    phaseAttr.needsUpdate = true;
  });

  return (
    // Group at (0, 5, -3) with worldHalf (14, 5, 16) gives the flock
    // the full hall plus generous headroom past the camera:
    //   x=-14 to +14  (room walls are around ±10, so ±4 of overshoot
    //                  lets birds exit frame sideways)
    //   y=0 to 10     (floor to ceiling)
    //   z=-19 to +13  (back curtain is at -22, camera at +6 — so
    //                  birds can go deep behind-stage and well past
    //                  the camera on the viewer's side)
    // The roaming goal above sends the flock on a tour through the
    // room's deep corners, past-camera space, and Venus' upper
    // area, so the whole volume actually gets used.
    // Dark warm-brown body (not pure black): under PBR diffuse ≈
    // baseColor × lightColor, so a near-black body can't reflect much
    // red no matter how strong the lights. #1a0d08 keeps the
    // silhouette dark but has enough red in the base that passes
    // through red zones visibly warm up. Slight metalness adds a
    // subtle sheen when catching the warm spots.
    <group position={[0, 5, -3]}>
      <instancedMesh ref={instancedRef} args={[geometry, material, NUM]} />
    </group>
  );
}

// ————— main scene —————

export function RedRoom() {
  // Show FPS stats only in debug mode: ?debug in URL or env flag set.
  // Matches the DebugPanel activation pattern in app/page.tsx.
  const [showStats, setShowStats] = useState(false);
  useEffect(() => {
    const urlDebug =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("debug");
    const envDebug = process.env.NEXT_PUBLIC_SEEN_DEBUG_PANEL === "1";
    setShowStats(urlDebug || envDebug);
  }, []);

  return (
    <Canvas
      shadows
      gl={{
        antialias: true,
        alpha: false,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 0.72,
      }}
      dpr={[1, 1.5]}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={["#220808"]} />
      <fog attach="fog" args={["#220808", 20, 60]} />

      <Suspense fallback={null}>
        <CameraRig />

        <hemisphereLight args={["#8a3030", "#2a0808", 0.25]} />
        <ambientLight intensity={0.08} color="#7a2828" />
        <AltarSpot />

        {/* Soft amber area lights behind the side velvet wall curtains */}
        <WallCurtainLights />

        <SideSconce position={[-10, 5.5, -4]} />
        <SideSconce position={[10, 5.5, -4]} />

        {/* Warm back rim so the foreground floor isn't pitch black */}
        <directionalLight
          position={[0, 4, 12]}
          intensity={0.2}
          color="#8a4818"
        />

        <Floor />
        <RedCarpet />
        <Walls />
        <Stage />

        {/* (Stage candelabras removed — the stage-deck candle ring
            now handles this area.) */}

        {/* Four empty armchairs — two rows flanking the carpet.
            Armchairs are wider than the old boxy chairs so push x
            outward a touch; Venus now lives near row 1 on the left
            so keep the left front chair back a little. */}
        {/* Audience — 4 pairs of armchairs, LEFT and RIGHT aligned
            on the same z rows (front row at z=-3.5, back row at
            z=-6.5). Each pair has a Twin-Peaks-style floor lamp on
            its outer side. */}
        {/* Front row — z=-3.5 */}
        <VelvetChair position={[-4.45, 0, -3.5]} />
        <VelvetChair position={[-3.35, 0, -3.5]} />
        <FloorLamp position={[-5.2, 0, -3.5]} />
        <VelvetChair position={[3.35, 0, -3.5]} />
        <VelvetChair position={[4.45, 0, -3.5]} />
        <FloorLamp position={[5.2, 0, -3.5]} />
        {/* Back row — z=-6.5 */}
        <VelvetChair position={[-4.45, 0, -6.5]} />
        <VelvetChair position={[-3.35, 0, -6.5]} />
        <FloorLamp position={[-5.2, 0, -6.5]} />
        <VelvetChair position={[3.35, 0, -6.5]} />
        <VelvetChair position={[4.45, 0, -6.5]} />
        <FloorLamp position={[5.2, 0, -6.5]} />

        <Venus />
        <TVSet />

        {/* Atmospheric dynamics */}
        <DustMotes />
        <Flock />
        <RavenFlyBy />
        <Rain />
        <LightningFlash />

        {/* FPS panel only when ?debug URL flag or env debug is set. */}
        {showStats && <Stats />}

        {/* Post-processing — kept lean for perf: CA for vintage lens
            feel, Vignette for frame darkness. Noise (film grain) was
            dropped as part of the perf cut pass. */}
        <EffectComposer>
          <ChromaticAberration
            offset={new THREE.Vector2(0.0008, 0.0008)}
            radialModulation={false}
            modulationOffset={0}
          />
          <Vignette offset={0.35} darkness={0.55} eskil={false} />
        </EffectComposer>
      </Suspense>
    </Canvas>
  );
}
