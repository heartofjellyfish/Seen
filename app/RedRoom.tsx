"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Cloud,
  Clouds,
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
      castShadow
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

// ————— Festoon — grand drape valance (two-half swag) —————
// Classical "grand drape" top valance: two symmetric swag panels that
// meet at a central gold rosette. Each half is a catenary-drooping
// piece with a scalloped lower lip, so the proscenium reads as an
// ornamental draped theatre top rather than a flat strip.

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

function makeSwagHalfGeometry(
  halfWidth: number,
  topHeight: number,
  centerHigh: number,    // how high the inner (center) edge is below top
  outerDrop: number,     // how far the outer edge hangs
  subScallops: number,
  scallopDepth: number,
  mirror: boolean,
): THREE.BufferGeometry {
  // Base coords: x=0 is the inner (center) edge, x=halfWidth is outer.
  const shape = new THREE.Shape();
  const topY = topHeight;
  const innerBottomY = -centerHigh;
  const outerBottomY = -outerDrop;

  shape.moveTo(0, topY);
  shape.lineTo(halfWidth, topY);
  shape.lineTo(halfWidth, outerBottomY);
  // Scalloped bottom sweeping outer → inner, atop a catenary sag
  const curveY = (t: number) =>
    outerBottomY + (innerBottomY - outerBottomY) * t +
    // subtle overall sag in the middle of the half
    Math.sin(t * Math.PI) * -0.1;
  const subW = halfWidth / subScallops;
  for (let i = 0; i < subScallops; i++) {
    const endX = halfWidth - subW * (i + 1);
    const startT = i / subScallops;
    const endT = (i + 1) / subScallops;
    const ctrlX = halfWidth - subW * (i + 0.5);
    const ctrlY = (curveY(startT) + curveY(endT)) / 2 - scallopDepth;
    shape.quadraticCurveTo(ctrlX, ctrlY, endX, curveY(endT));
  }
  shape.lineTo(0, topY);
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape, 64);
  if (mirror) geo.scale(-1, 1, 1);
  return geo;
}

function Festoon({
  width,
  position,
}: {
  width: number;
  position: [number, number, number];
}) {
  const halfW = width / 2;
  const geoLeft  = useMemo(() => makeSwagHalfGeometry(halfW, 0.15, 0.50, 1.25, 5, 0.20, true),  [halfW]);
  const geoRight = useMemo(() => makeSwagHalfGeometry(halfW, 0.15, 0.50, 1.25, 5, 0.20, false), [halfW]);

  // Shared pleat-shading texture — same instance for both halves.
  const pleatTex = useMemo(() => {
    const t = makeVelvetPleatTexture();
    // Planar UVs from ShapeGeometry map 1:1 to world coords, so we
    // repeat the pleat pattern a few times across the width.
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(2, 1);
    return t;
  }, []);

  return (
    <group position={position}>
      {/* Left half of the grand drape. Dark wine base. Emissive kept
          very low so the upper corners stay properly shadowed (nothing
          really lights this area). The pleat texture gives the tonal
          variation that reads as folded velvet. */}
      <mesh geometry={geoLeft} castShadow>
        <meshStandardMaterial
          map={pleatTex}
          color="#5a0e0e"
          roughness={0.92}
          metalness={0}
          emissive="#200303"
          emissiveIntensity={0.12}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Right half */}
      <mesh geometry={geoRight} castShadow>
        <meshStandardMaterial
          map={pleatTex}
          color="#5a0e0e"
          roughness={0.92}
          metalness={0}
          emissive="#200303"
          emissiveIntensity={0.12}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Central gold rosette where the two halves tie together */}
      <mesh position={[0, -0.42, 0.04]} castShadow>
        <sphereGeometry args={[0.18, 20, 14]} />
        <meshStandardMaterial
          color="#8e6a24"
          roughness={0.45}
          metalness={0.8}
          emissive="#2a1a06"
          emissiveIntensity={0.18}
        />
      </mesh>
      {/* Tassel hanging below the rosette */}
      <mesh position={[0, -0.66, 0.04]} castShadow>
        <coneGeometry args={[0.07, 0.28, 14]} />
        <meshStandardMaterial
          color="#7a5018"
          roughness={0.6}
          metalness={0.55}
          emissive="#1a1006"
          emissiveIntensity={0.15}
        />
      </mesh>
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
        castShadow
        receiveShadow
      >
        <boxGeometry args={[stageW, stageH, 0.6]} />
        <meshStandardMaterial color="#1a0505" roughness={0.88} />
      </mesh>
      {/* Stage floor trim — a thin brass strip at the APRON front */}
      <mesh position={[0, stageH + 0.03, stageD / 2 + 0.6]} castShadow>
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
        castShadow
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

// ————— stage mist — one big drei Cloud —————
// A single large <Cloud> sitting above the stage deck. drei's Cloud
// is a billboard-sprite volume — for a stage-sized puff that drifts
// in place (no emitter logic, no lifecycle) this is the right fit.
// Bounds are roughly balanced (not a pancake) so it reads as a big
// puffy cloud, not a flat fog strip.

function StageMist({
  stageW,
  stageD,
  stageH,
}: {
  stageW: number;
  stageD: number;
  stageH: number;
}) {
  return (
    <group position={[0, stageH + 2.4, stageD / 2 - 0.3]}>
      <Clouds material={THREE.MeshLambertMaterial} limit={400}>
        <Cloud
          seed={7}
          segments={22}                   // fewer pieces → less visible puff count
          bounds={[5.5, 1.8, 1.8]}        // tighter, not spread out
          volume={5}
          smallestVolume={1.2}            // no tiny stragglers at edges
          growth={4.0}                    // each piece big → they merge, not separate
          speed={0.10}
          concentrate="inside"
          color="#c8c0b0"
          opacity={0.9}
          fade={25}
        />
      </Clouds>
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
      <mesh position={[0, 0.005, 0]} castShadow>
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
  return <mesh position={[0, 1.51, 0]} geometry={geometry} material={material} />;
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
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.26, 0.08, 24]} />
        <meshStandardMaterial color="#3a2a14" metalness={0.7} roughness={0.55} />
      </mesh>
      {/* Thin brass pole */}
      <mesh position={[0, 1.5, 0]} castShadow>
        <cylinderGeometry args={[0.03, 0.03, 3, 12]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.4} />
      </mesh>
      {/* Bowl at top — shallow cone, open upward */}
      <mesh position={[0, 3.08, 0]} castShadow>
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
      <mesh position={[-1.3, 0.02, -3.5]} castShadow>
        <boxGeometry args={[0.04, 0.02, 18]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.45} />
      </mesh>
      <mesh position={[1.3, 0.02, -3.5]} castShadow>
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
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.2, 0.08, 24]} />
        <meshStandardMaterial color="#3a2614" metalness={0.7} roughness={0.5} />
      </mesh>
      {/* Stem */}
      <mesh position={[0, 0.45, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.028, 0.8, 14]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.4} />
      </mesh>
      {/* Crossbar */}
      <mesh position={[0, 0.84, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 0.62, 12]} />
        <meshStandardMaterial color="#8b6a34" metalness={0.8} roughness={0.4} />
      </mesh>
      {branches.map(([dx, dy], i) => (
        <group key={i} position={[dx, 0.88 + dy, 0]}>
          {/* Tiny cup */}
          <mesh position={[0, 0.02, 0]} castShadow>
            <cylinderGeometry args={[0.05, 0.04, 0.03, 14]} />
            <meshStandardMaterial
              color="#8b6a34"
              metalness={0.8}
              roughness={0.4}
            />
          </mesh>
          {/* Candle wax */}
          <mesh position={[0, 0.11, 0]} castShadow>
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
      <mesh position={[0, 0.18, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.05, 0.22, 0.82]} />
        <meshStandardMaterial
          color="#2a1608"
          roughness={0.6}
          metalness={0.3}
        />
      </mesh>
      {/* Seat cushion — puffy */}
      <mesh position={[0, 0.42, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.82, 0.18, 0.68]} />
        {velvet}
      </mesh>
      {/* Back cushion — tall, padded */}
      <mesh position={[0, 0.85, 0.3]} castShadow>
        <boxGeometry args={[0.82, 0.72, 0.2]} />
        {velvet}
      </mesh>
      {/* Rolled bolster at top of back */}
      <mesh
        position={[0, 1.24, 0.3]}
        rotation={[0, 0, Math.PI / 2]}
        castShadow
      >
        <cylinderGeometry args={[0.1, 0.1, 0.82, 20]} />
        {velvet}
      </mesh>
      {/* Left arm — padded block */}
      <mesh position={[-0.46, 0.58, 0.05]} castShadow>
        <boxGeometry args={[0.18, 0.5, 0.72]} />
        {velvet}
      </mesh>
      {/* Right arm */}
      <mesh position={[0.46, 0.58, 0.05]} castShadow>
        <boxGeometry args={[0.18, 0.5, 0.72]} />
        {velvet}
      </mesh>
      {/* Arm top rolls */}
      <mesh
        position={[-0.46, 0.85, 0.05]}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
      >
        <cylinderGeometry args={[0.09, 0.09, 0.72, 16]} />
        {velvet}
      </mesh>
      <mesh
        position={[0.46, 0.85, 0.05]}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow
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
        <mesh key={i} position={p} castShadow>
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
      <mesh position={[0, 0.125, 0]} castShadow>
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
// Flight choreography (this is what earlier versions got wrong):
//   1. Each flight uses one of three HAND-AUTHORED routes — not
//      random wander waypoints. Old behaviour used 4 random waypoints
//      which produced visibly aimless meanders. Every waypoint now
//      means something.
//   2. Each route has a built-in HOVER/PAUSE moment ~55% through
//      where the bird slows to ~15% speed for ~1.5s, wings spread,
//      visible and still — the "be seen" beat that makes it a
//      spectacle rather than a bird.
//   3. After the pause, fast committed dive to near-miss, then rapid
//      exit past the camera.
//   4. Wingbeat timeScale modulates with the curve — slow during
//      pause (0.2×), normal during approach (0.5×), quick during
//      commit (1.0×). Reads as the bird "gearing up" before it dives.
//
// Three routes: stage-curtain emergence (most common), lateral
// sweep past eye level, overhead dive. Every path was laid out
// against camera at (0, 1.65, 6) fov 55° looking at (0, 3, -13).
//
// Tuning constants are all named ROUTE_*, PAUSE_*, SPEED_* below —
// grep for those to adjust.

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
  const lastGoodLook = useRef(new THREE.Vector3(0, 0, 6)); // persists between frames for pause-stability

  const state = useRef({
    flying: false,
    startTime: 0,
    duration: 10.0, // tight — no aimless wandering
    nextFlightAt: 10 + Math.random() * 10, // first appearance 10–20s in
    curve: null as THREE.CatmullRomCurve3 | null,
    pauseCenter: 0.55, // where on the curve the hover beat sits
  });

  // Three hand-authored routes. Each is a complete list of CatmullRom
  // control points, placed deliberately so the curve tells a story:
  //   entry → reveal → HOVER → dive → near-miss → exit past camera.
  //
  // Slight randomisation on a few points (±0.3m) so repeat flights
  // aren't bit-identical, but the character of each route is fixed.
  type Route = {
    name: string;
    pauseAt: number;            // curve parameter at hover point (0..1)
    pts: () => THREE.Vector3[]; // 6–8 control points, hover included
  };
  const routes: Route[] = useMemo(() => {
    const jitter = (v: number, amt = 0.3) => v + (Math.random() - 0.5) * 2 * amt;
    return [
      {
        // ROUTE_EMERGE: appears out of the back curtain at stage level,
        // crawls forward over the stage (barely moving for dramatic
        // reveal), pauses in the middle of the carpet, then dives at
        // the lens. The archetypal "something was behind the curtain
        // all along" shot. Most common (weight 2× the others).
        name: "emerge",
        pauseAt: 0.52,
        pts: () => [
          new THREE.Vector3(jitter(-0.8, 0.6), 2.4, -21.5),  // behind curtain (invisible)
          new THREE.Vector3(jitter(-0.3, 0.4), 2.5, -17),    // slipping through the curtain seam
          new THREE.Vector3(jitter(0, 0.3), 2.6, -11),       // mid-stage, starts to be noticed
          new THREE.Vector3(jitter(0, 0.2), 2.3, -5.5),      // HOVER: carpet front, wings out
          new THREE.Vector3(jitter(0.3, 0.4), 2.0, -1),      // tips into dive
          new THREE.Vector3(jitter(0, 0.3), 1.8, 4.3),       // NEAR PASS
          new THREE.Vector3(jitter(-1.5, 1), 3.5, 8),        // past-camera exit
        ],
      },
      {
        // ROUTE_LATERAL: enters from one side wall at eye level,
        // sweeps horizontally across the hall between the chairs and
        // the stage. Hover happens dead centre. Chooses left→right or
        // right→left randomly per flight. The "sees the audience"
        // route — bird drifts across your field of view as if
        // surveying.
        name: "lateral",
        pauseAt: 0.50,
        pts: () => {
          const dir = Math.random() < 0.5 ? -1 : 1; // -1 = L→R, +1 = R→L
          return [
            new THREE.Vector3(-13 * dir, 3.0, jitter(-7, 1)),   // outside side wall (hidden)
            new THREE.Vector3(-8 * dir, 2.9, jitter(-6, 0.8)),  // through invisible wall
            new THREE.Vector3(-3 * dir, 2.7, jitter(-5, 0.5)),  // over the chairs
            new THREE.Vector3(0, 2.5, -4.5),                    // HOVER: dead centre
            new THREE.Vector3(3 * dir, 2.5, jitter(-3, 0.3)),
            new THREE.Vector3(6 * dir, 2.7, jitter(-2, 0.4)),
            new THREE.Vector3(13 * dir, 3.0, jitter(-1, 1)),    // exit through opposite wall
          ];
        },
      },
      {
        // ROUTE_DIVE: high emergence from the ceiling area at the
        // back of the stage, nearly motionless hover at the apex,
        // then a steep dive to a low pass near the carpet, pulls up
        // past the lens. The "from on high" route — classic
        // Hitchcock framing of a hostile bird.
        name: "dive",
        pauseAt: 0.30,
        pts: () => [
          new THREE.Vector3(jitter(0, 2), 7.5, -17),        // high + far back
          new THREE.Vector3(jitter(0, 1.5), 7.2, -12),      // coasting
          new THREE.Vector3(jitter(0, 0.6), 6.8, -8),       // HOVER: apex (weight tilts curve here via pauseAt=0.30)
          new THREE.Vector3(jitter(0.5, 0.5), 4.5, -3),     // mid dive
          new THREE.Vector3(jitter(0, 0.4), 2.0, 1),        // almost at the carpet
          new THREE.Vector3(jitter(0, 0.3), 1.7, 4.5),      // NEAR PASS, pulling up
          new THREE.Vector3(jitter(-1, 0.8), 4.5, 8),       // shoots past camera up-and-left-ish
        ],
      },
    ];
  }, []);

  const generatePath = () => {
    // Weight ROUTE_EMERGE 2× since it's the signature shot.
    const roll = Math.random();
    let chosen: Route;
    if (roll < 0.5) chosen = routes[0];
    else if (roll < 0.78) chosen = routes[1];
    else chosen = routes[2];
    const curve = new THREE.CatmullRomCurve3(chosen.pts());
    // Slight tension tuning — default (0.5) gives gentle arcs; lower
    // values would make corners sharper. Stick with default.
    state.current.pauseCenter = chosen.pauseAt;
    return curve;
  };

  // Speed/easing profile. Maps raw time (0..1) to curve parameter
  // (0..1), with a flat zone around the hover point.
  //
  //   0 .. pauseStart:  linear approach (covers first ~50% of curve)
  //   pauseStart .. pauseEnd:  nearly flat — curve param advances ~8%
  //                            over 18% of time. This is the visible
  //                            stillness that sells the spectacle.
  //   pauseEnd .. 1.0:  accelerating dive-and-exit (smoothstep^2)
  //
  // PAUSE_WIDTH and PAUSE_ADVANCE together decide how much the bird
  // moves during the hover (smaller = stiller).
  const PAUSE_WIDTH = 0.18;
  const PAUSE_ADVANCE = 0.08;
  const curveParamForTime = (raw: number, center: number): number => {
    const pauseStart = center - PAUSE_WIDTH / 2;
    const pauseEnd = center + PAUSE_WIDTH / 2;

    // Curve-param budget split so the whole duration maps to 0..1 end-to-end.
    // Pre-pause covers [0, center - PAUSE_ADVANCE/2];
    // pause covers [center - PAUSE_ADVANCE/2, center + PAUSE_ADVANCE/2];
    // post-pause covers [center + PAUSE_ADVANCE/2, 1].
    const preEnd = center - PAUSE_ADVANCE / 2;
    const postStart = center + PAUSE_ADVANCE / 2;

    if (raw < pauseStart) {
      // Linear through the pre-pause section.
      return (raw / pauseStart) * preEnd;
    } else if (raw < pauseEnd) {
      // Nearly flat — advance only PAUSE_ADVANCE of curve over PAUSE_WIDTH of time.
      const local = (raw - pauseStart) / PAUSE_WIDTH;
      // Subtle eased drift so it's not literally frozen.
      const eased = local * local * (3 - 2 * local); // smoothstep
      return preEnd + eased * PAUSE_ADVANCE;
    } else {
      // Smoothstep-squared accelerate into exit.
      const local = (raw - pauseEnd) / (1 - pauseEnd);
      const s = local * local * (3 - 2 * local);
      const accel = s * s; // extra bite near the end
      return postStart + accel * (1 - postStart);
    }
  };

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    const s = state.current;

    if (!s.flying && t >= s.nextFlightAt) {
      s.flying = true;
      s.startTime = t;
      s.duration = 9 + Math.random() * 2.5; // 9–11.5s per flight — tight
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
      // Long dwell — flights should feel rare. Combined with 9–11s
      // per flight, a raven is onscreen ~20% of the time.
      s.nextFlightAt = t + 30 + Math.random() * 30; // 30–60s dwell
      groupRef.current.visible = false;
      s.curve = null;
      return;
    }

    const p = curveParamForTime(raw, s.pauseCenter);

    // Wingbeat: slow during approach (0.4×), minimal during pause
    // (0.18×, near-glide), fast during commit/exit (1.1×).
    if (flapAction.current) {
      const pauseStart = s.pauseCenter - PAUSE_WIDTH / 2;
      const pauseEnd = s.pauseCenter + PAUSE_WIDTH / 2;
      let timeScale: number;
      if (raw < pauseStart) {
        timeScale = 0.4;
      } else if (raw < pauseEnd) {
        // Ramp down into pause, then back up
        const local = (raw - pauseStart) / PAUSE_WIDTH;
        // V-shape: 0.4 → 0.18 → 0.4
        const v = Math.abs(local - 0.5) * 2;
        timeScale = 0.18 + 0.22 * v;
      } else {
        // Post-pause: 0.5 ramping to 1.1 by the end
        const local = (raw - pauseEnd) / (1 - pauseEnd);
        timeScale = 0.5 + 0.6 * local;
      }
      flapAction.current.timeScale = timeScale;
    }

    s.curve.getPoint(p, posVec);
    s.curve.getTangent(p, tanVec);

    groupRef.current.visible = true;
    groupRef.current.position.copy(posVec);

    // LookAt using tangent direction — but during the hover the
    // tangent magnitude drops near-zero, which makes lookAt jittery
    // (it'll keep facing whatever random noise is in the tangent).
    // Keep the last stable look direction when the tangent is weak.
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
// wings. Vertices 4 and 5 are the wingtips; we oscillate their Y
// per-frame for the flap.
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
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(verts, 3));
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

  // Room is x=±11, y=0–9, z=-16 to +8. Box tuned so 40 birds produce
  // demo-like density.
  //   worldHalf (14, 5, 16) → volume 8960
  //   density 60/8960 = 0.0067 per unit³
  //   neighbors at radius 8: 0.0067 * (4/3 π 512) = 14.4 → ~5.7
  //   after 40% sampling. Enough for each bird's cohesion average
  //   to actually reflect the flock, producing real group motion.
  worldHalf = new THREE.Vector3(14, 5, 16);
  // Wider neighborhood so each bird actually sees the flock when
  // computing cohesion/alignment averages. At radius 5 and our low
  // density, only ~1.4 neighbors were active per call (after 40%
  // sampling) — too few to produce statistical coherence, which is
  // why the flock felt like a loose scatter of independents. At
  // radius 8 active neighbors become ~5.7 and real group behavior
  // emerges.
  neighborhoodRadius = 8.0;
  maxSpeed = 0.12;
  // 50:1 ratio of maxSpeed:maxSteerForce matches the pen and gives
  // the gentle-arc feel — steering takes many frames to redirect
  // velocity, so turns draw smooth curves instead of snapping.
  maxSteerForce = 0.0024;
  goal: THREE.Vector3 | null = null;
  avoidWalls = true;

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
        .multiplyScalar(0.0005);
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

  // Each bird gets its own geometry clone so wing-flap vertex writes
  // don't affect its neighbors.
  const geos = useMemo(() => boids.map(() => makeBirdGeo()), [boids]);
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);

  // Roaming goal — a waypoint the whole flock slowly steers toward.
  // Two pools of waypoints, strictly alternating: the flock hides
  // off-frame for ~18s, swoops through the visible area for ~5s,
  // hides again. Hidden time is 70–78% overall, so each visible
  // pass feels like an event rather than continuous ambient motion.
  //
  // Hideouts sit just inside the box edges (wall-avoid prevents
  // reaching them exactly, but d=1–2 from the wall is enough to
  // keep the flock outside the camera frustum). Shows sit inside
  // the visible stage area — the flock passes THROUGH frame on its
  // way to each show waypoint, then transits back out again.
  //
  // Waypoints are in WORLD coords; converted to local by subtracting
  // the <group> position.
  const GROUP_POS = useMemo(() => new THREE.Vector3(0, 5, -3), []);
  const { hideouts, shows } = useMemo(() => {
    const toLocal = (wx: number, wy: number, wz: number, dwell: number) => ({
      local: new THREE.Vector3(wx - GROUP_POS.x, wy - GROUP_POS.y, wz - GROUP_POS.z),
      dwell,
    });
    return {
      // 6 hideouts, 18s each. All reliably outside the fov 55°
      // frustum on BOTH portrait and landscape viewports:
      //   - z > camera.z (=6) puts the bird behind the camera —
      //     the most robust offscreen test, works any aspect.
      //   - |x| ≥ 12 at z=-3 (distance 9 from camera): landscape
      //     horizontal half-width ≈ 8.2 → outside. Portrait narrower
      //     still. Safe.
      // Previously had (0, 9, -17) listed as a hideout but at z=-17
      // frame-center-y is 3.28 and frame half-height is 11.96, so
      // y=9 sits only 48% up from center — fully in frame. Removed.
      hideouts: [
        toLocal(0, 8, 10, 18),     // behind camera, high center
        toLocal(0, 1, 11, 18),     // behind camera, low center
        toLocal(9, 5, 10, 18),     // behind camera, slight right
        toLocal(-9, 5, 10, 18),    // behind camera, slight left
        toLocal(12, 8, -3, 18),    // far-right, high (beyond lateral frustum)
        toLocal(-12, 8, -3, 18),   // far-left, high
      ],
      // 5 shows, 5s each — clearly inside the visible area. This is
      // where the user's eye is rewarded. Includes the deep-back
      // corners (|x|=4 at z=-16 is inside the frustum even on
      // portrait aspect) so the flock does visit the back-stage.
      // Transit from any hideout to any show passes the flock
      // through the camera frame, which IS the spectacle.
      shows: [
        toLocal(-4, 5, 1, 5),      // dive over Venus
        toLocal(0, 4, -10, 5),     // sweep through upper stage
        toLocal(3, 3, -5, 5),      // mid-room center dive
        toLocal(4, 7, -16, 5),     // deep back-right corner
        toLocal(-4, 7, -16, 5),    // deep back-left corner
      ],
    };
  }, [GROUP_POS]);

  // Start on a show so the opening 5s rewards the viewer immediately
  // (an 18s hide-transit at t=0 would look like nothing is happening).
  // The next cycle flips to hide, then show, then hide — so across
  // time the ~18:5 hide:show ratio still holds.
  const goal = useRef(new THREE.Vector3().copy(shows[0].local));
  const current = useRef(shows[0]);
  const phase = useRef<"hide" | "show">("show");
  const waypointStart = useRef(0);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (t - waypointStart.current > current.current.dwell) {
      waypointStart.current = t;
      // Strict alternation: hide → show → hide → show …
      // so the viewer gets a predictable spectacle cadence.
      phase.current = phase.current === "hide" ? "show" : "hide";
      const pool = phase.current === "hide" ? hideouts : shows;
      const next = pool[Math.floor(Math.random() * pool.length)];
      current.current = next;
      goal.current.copy(next.local);
    }

    for (let i = 0; i < boids.length; i++) {
      const b = boids[i];
      const mesh = meshRefs.current[i];
      if (!mesh) continue;
      b.goal = goal.current;
      b.run(boids);

      mesh.position.copy(b.position);
      mesh.rotation.y = Math.atan2(-b.velocity.z, b.velocity.x);
      const speed = b.velocity.length();
      mesh.rotation.z = speed > 1e-6 ? Math.asin(b.velocity.y / speed) : 0;

      // Flap: wingtip y oscillates sin(phase) * scale.
      b.phase =
        (b.phase + Math.max(0, mesh.rotation.z) + 0.1) % 62.83;
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      const flap = Math.sin(b.phase) * BIRD_WING_SCALE;
      pos.setY(4, flap);
      pos.setY(5, flap);
      pos.needsUpdate = true;
    }
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
    <group position={[0, 5, -3]}>
      {boids.map((_, i) => (
        <mesh
          key={i}
          geometry={geos[i]}
          ref={(m) => {
            meshRefs.current[i] = m;
          }}
        >
          {/* Dark warm-brown body (not pure black): under PBR
              diffuse ≈ baseColor × lightColor, so a near-black
              body can't reflect much red no matter how strong the
              lights. #1a0d08 keeps the silhouette dark but has
              enough red in the base that passes through red zones
              visibly warm up. Slight metalness adds a subtle sheen
              when catching the warm spots. */}
          <meshStandardMaterial
            color="#1a0d08"
            side={THREE.DoubleSide}
            roughness={0.5}
            metalness={0.1}
          />
        </mesh>
      ))}
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
        <VelvetChair position={[-3.9, 0, -4]} />
        <VelvetChair position={[3.9, 0, -3]} />
        <VelvetChair position={[-3.9, 0, -7]} />
        <VelvetChair position={[3.9, 0, -6]} />

        <Venus />

        {/* Atmospheric dynamics */}
        <DustMotes />
        <Flock />
        <RavenFlyBy />

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
