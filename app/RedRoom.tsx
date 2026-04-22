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
        <mesh key={i} geometry={rowGeos[i]} position={[0, r.y, r.z]} castShadow>
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
          <mesh castShadow>
            <sphereGeometry args={[0.07, 12, 10]} />
            <meshStandardMaterial
              color="#8e6a24"
              roughness={0.45}
              metalness={0.8}
              emissive="#2a1a06"
              emissiveIntensity={0.28}
            />
          </mesh>
          <mesh position={[0, -0.14, 0]} castShadow>
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

      {/* A dancing cloud standing where the performer would stand.
          The app is about one person being seen for 15 minutes; the
          rest of the day, the stage is empty. The cloud fills the
          absence — slow sway + pirouette + breathing bob. */}
      <DancingCloud stageH={stageH} stageD={stageD} />
    </group>
  );
}

// ————— Dancing clouds — ghost performers on the apron —————
// Three variants, selectable via ?cloud=a|b|c in the URL.
//   a) Single massive solo — one wide cloud sweeping slowly
//   b) Trio (default)       — three clouds at x={-3, 0, +3}
//   c) Duet                 — two clouds dancing toward each other
//
// Materials: MeshBasicMaterial so the clouds keep their own pale color
// and don't pick up the room's red light (which made the single-cloud
// version read as "on fire"). High opacity + pale off-white means the
// curtain's pleat pattern doesn't bleed through as stripes.

type CloudVariant = "a" | "b" | "c";

// A single dancing cloud group. Still air: only gentle translation,
// no rotation (rotation reads as wind-driven which is wrong for clouds
// supposed to be floating motionless inside a theatre).
function DancingCloudBody({
  basePos,
  bounds,
  seed,
  phase,
  swaySpeed,
  breathSpeed,
  swayAmp = 0.4,
}: {
  basePos: [number, number, number];
  bounds: [number, number, number];
  seed: number;
  phase: number;
  swaySpeed: number;
  breathSpeed: number;
  swayAmp?: number;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = ref.current;
    if (!g) return;
    const t = clock.elapsedTime;
    // Only translate — no rotation. The cloud's internal `speed` prop
    // already churns its silhouette; outer rotation makes it look
    // pushed by wind.
    g.position.x = basePos[0] + Math.sin(t * swaySpeed + phase) * swayAmp;
    g.position.y = basePos[1] + Math.cos(t * breathSpeed + phase) * 0.09;
  });
  return (
    <group ref={ref} position={basePos}>
      <Cloud
        seed={seed}
        segments={38}
        bounds={bounds}
        volume={bounds[0] * 1.35}
        smallestVolume={1.0}
        growth={3.8}
        speed={0.09}
        concentrate="inside"
        color="#b8ac8e"
        opacity={0.55}
        fade={50}
      />
    </group>
  );
}

function useCloudVariant(): CloudVariant {
  const [variant, setVariant] = useState<CloudVariant>("b");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = new URLSearchParams(window.location.search).get("cloud");
    if (v === "a" || v === "b" || v === "c") setVariant(v);
  }, []);
  return variant;
}

function DancingCloud({
  stageH,
  stageD,
}: {
  stageH: number;
  stageD: number;
}) {
  const variant = useCloudVariant();
  const y = stageH + 1.6;
  // Sit back on the apron, close to the curtain — keeps clouds clearly
  // "on the stage" even at their forward-most breath position.
  const z = stageD / 2 + 0.25;

  let bodies: React.ReactNode = null;

  if (variant === "a") {
    // Massive solo — one wide cloud sweeping slowly
    bodies = (
      <DancingCloudBody
        basePos={[0, y, z]}
        bounds={[5.5, 2.5, 1.8]}
        seed={7}
        phase={0}
        swaySpeed={0.15}
        breathSpeed={0.28}
        swayAmp={0.8}
      />
    );
  } else if (variant === "c") {
    // Duet — two clouds drifting toward / away from each other
    bodies = (
      <>
        <DancingCloudBody
          basePos={[-1.6, y, z]}
          bounds={[2.4, 2.0, 1.5]}
          seed={11}
          phase={0}
          swaySpeed={0.18}
          breathSpeed={0.32}
          swayAmp={0.5}
        />
        <DancingCloudBody
          basePos={[1.6, y, z]}
          bounds={[2.4, 2.0, 1.5]}
          seed={23}
          phase={Math.PI}  // opposite phase
          swaySpeed={0.18}
          breathSpeed={0.32}
          swayAmp={0.5}
        />
      </>
    );
  } else {
    // Trio (default) — three small clouds, tight positions, minimal drift
    bodies = (
      <>
        <DancingCloudBody
          basePos={[-2.3, y, z]}
          bounds={[1.6, 1.5, 1.2]}
          seed={5}
          phase={0}
          swaySpeed={0.20}
          breathSpeed={0.34}
          swayAmp={0.3}
        />
        <DancingCloudBody
          basePos={[0, y + 0.05, z + 0.08]}
          bounds={[2.0, 1.7, 1.3]}
          seed={13}
          phase={1.5}
          swaySpeed={0.17}
          breathSpeed={0.29}
          swayAmp={0.35}
        />
        <DancingCloudBody
          basePos={[2.3, y, z]}
          bounds={[1.6, 1.5, 1.2]}
          seed={29}
          phase={3.0}
          swaySpeed={0.22}
          breathSpeed={0.36}
          swayAmp={0.3}
        />
      </>
    );
  }

  return (
    <Clouds material={THREE.MeshBasicMaterial} limit={500}>
      {bodies}
    </Clouds>
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

// ————— Indoor drizzle spectacle —————
// Surreal indoor rain — Twin Peaks-style. Light, atmospheric, never
// dominant. Each drop is a short LINE SEGMENT (not a point) so it
// reads as a vertical streak rather than a hailstone pellet.
//
// State machine — every rain event has four phases:
//   dry      → idle, no drops rendered (50–80s)
//   ramp-in  → opacity 0 → max over 2s (sparse drizzle thickening)
//   steady   → full max opacity (7–11s of "rain curtain")
//   ramp-out → opacity max → 0 over 2s (drizzle dying away)
// Total visible rain ≈ 11–15s, then back to dry.
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
  const N = 280;
  const STREAK_LEN = 0.35;
  const MAX_OPACITY = 0.4;
  const RAMP_IN_DUR = 2.0;
  const RAMP_OUT_DUR = 2.0;

  const linesRef = useRef<THREE.LineSegments>(null);
  const matRef = useRef<THREE.LineBasicMaterial>(null);

  // Each segment = 2 vertices = 6 floats. Initial positions are
  // distributed throughout the volume; they're re-randomised at each
  // ramp-in start (see scatterDrops below) so this initial layout
  // only matters for the very first event.
  const { positions, velocities, geometry } = useMemo(() => {
    const positions = new Float32Array(N * 6);
    const velocities = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 18;     // x: -9 to 9
      const y = Math.random() * 10;             // y: 0–10
      const z = (Math.random() - 0.5) * 14 - 3; // z: -10 to 4
      positions[i * 6 + 0] = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = y - STREAK_LEN;
      positions[i * 6 + 5] = z;
      velocities[i] = 5 + Math.random() * 2; // 5–7 m/s drizzle pace
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return { positions, velocities, geometry: g };
  }, []);

  // Re-scatter drops throughout the volume — used at ramp-in start
  // so a new event doesn't "wake up" with drops frozen at last
  // event's bottom positions (which would look unnatural).
  const scatterDrops = () => {
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 18;
      const y = Math.random() * 10;
      const z = (Math.random() - 0.5) * 14 - 3;
      positions[i * 6 + 0] = x;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = z;
      positions[i * 6 + 3] = x;
      positions[i * 6 + 4] = y - STREAK_LEN;
      positions[i * 6 + 5] = z;
    }
    geometry.attributes.position.needsUpdate = true;
  };

  type Phase = "dry" | "ramp-in" | "steady" | "ramp-out";
  const cycle = useRef<{ phase: Phase; phaseStart: number; phaseDuration: number }>({
    phase: "dry",
    phaseStart: 0,
    phaseDuration: 8 + Math.random() * 8, // first dry is shorter so user sees rain quickly
  });

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    let elapsed = t - cycle.current.phaseStart;

    // Phase transition
    if (elapsed > cycle.current.phaseDuration) {
      cycle.current.phaseStart = t;
      elapsed = 0;
      switch (cycle.current.phase) {
        case "dry":
          cycle.current.phase = "ramp-in";
          cycle.current.phaseDuration = RAMP_IN_DUR;
          scatterDrops();
          break;
        case "ramp-in":
          cycle.current.phase = "steady";
          cycle.current.phaseDuration = 7 + Math.random() * 4; // 7–11s
          break;
        case "steady":
          cycle.current.phase = "ramp-out";
          cycle.current.phaseDuration = RAMP_OUT_DUR;
          break;
        case "ramp-out":
          cycle.current.phase = "dry";
          cycle.current.phaseDuration = 50 + Math.random() * 30; // 50–80s
          break;
      }
    }

    // Compute opacity from phase + elapsed
    let opacity = 0;
    if (cycle.current.phase === "ramp-in") {
      opacity = (elapsed / RAMP_IN_DUR) * MAX_OPACITY;
    } else if (cycle.current.phase === "steady") {
      opacity = MAX_OPACITY;
    } else if (cycle.current.phase === "ramp-out") {
      opacity = (1 - elapsed / RAMP_OUT_DUR) * MAX_OPACITY;
    } // "dry" → 0

    if (matRef.current) matRef.current.opacity = opacity;

    // Skip per-particle update when not visible — zero perf cost dry.
    if (opacity < 0.001) {
      if (linesRef.current) linesRef.current.visible = false;
      return;
    }
    if (linesRef.current) linesRef.current.visible = true;

    // Update each streak: top + bottom both fall by velocity*dt.
    // Respawn at top when bottom passes the floor.
    for (let i = 0; i < N; i++) {
      const fall = velocities[i] * dt;
      positions[i * 6 + 1] -= fall;
      positions[i * 6 + 4] -= fall;
      if (positions[i * 6 + 4] < 0) {
        const x = (Math.random() - 0.5) * 18;
        const z = (Math.random() - 0.5) * 14 - 3;
        const newY = 9 + Math.random() * 2;
        positions[i * 6 + 0] = x;
        positions[i * 6 + 1] = newY;
        positions[i * 6 + 2] = z;
        positions[i * 6 + 3] = x;
        positions[i * 6 + 4] = newY - STREAK_LEN;
        positions[i * 6 + 5] = z;
      }
    }
    geometry.attributes.position.needsUpdate = true;
  });

  return (
    <lineSegments ref={linesRef} geometry={geometry} visible={false}>
      <lineBasicMaterial
        ref={matRef}
        color="#d0d8e4"
        transparent
        opacity={0}
        depthWrite={false}
      />
    </lineSegments>
  );
}

// ————— Lightning flash spectacle —————
// Brief room-wide white flash, like a flashbulb or distant lightning
// strike. Implementation: AmbientLight whose intensity is normally 0,
// pulsed up to ~5 for 60–150ms total. The room's existing lights are
// in the 1–3 range, so 5 of pure-white ambient does whitewash the
// scene briefly.
//
// Pattern: 50% chance of a single flash, 50% chance of a double-flash
// (real lightning often has multiple strokes, ~50–100ms apart). Gap
// between flash events 30–90s — frequent enough to feel like a
// recurring presence, rare enough to startle.

const FLASH_PEAK_INTENSITY = 5.0;

function LightningFlash() {
  const lightRef = useRef<THREE.AmbientLight>(null);

  // A flash event has 1–2 BURSTS; each burst is (start_offset_in_event,
  // duration). Outside any burst, intensity is 0.
  type Burst = { startOffset: number; duration: number };
  const cycle = useRef({
    flashing: false,
    flashStart: 0,
    nextFlashAt: 15 + Math.random() * 25, // first flash 15–40s in
    bursts: [] as Burst[],
  });

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    // Schedule next flash event.
    if (!cycle.current.flashing && t > cycle.current.nextFlashAt) {
      cycle.current.flashing = true;
      cycle.current.flashStart = t;
      if (Math.random() < 0.5) {
        // Single flash, 100–150ms.
        cycle.current.bursts = [
          { startOffset: 0, duration: 0.10 + Math.random() * 0.05 },
        ];
      } else {
        // Double flash. First burst short (60–100ms), gap 80–130ms,
        // second burst slightly longer (90–140ms).
        const firstDur = 0.06 + Math.random() * 0.04;
        const gap = 0.08 + Math.random() * 0.05;
        cycle.current.bursts = [
          { startOffset: 0, duration: firstDur },
          { startOffset: firstDur + gap, duration: 0.09 + Math.random() * 0.05 },
        ];
      }
    }

    if (!cycle.current.flashing) {
      if (lightRef.current) lightRef.current.intensity = 0;
      return;
    }

    const dt = t - cycle.current.flashStart;

    // Compute current intensity based on which burst is active.
    let intensity = 0;
    for (const b of cycle.current.bursts) {
      if (dt >= b.startOffset && dt < b.startOffset + b.duration) {
        intensity = FLASH_PEAK_INTENSITY;
        break;
      }
    }
    if (lightRef.current) lightRef.current.intensity = intensity;

    // End the event after the last burst finishes. Schedule next.
    const last = cycle.current.bursts[cycle.current.bursts.length - 1];
    if (dt > last.startOffset + last.duration) {
      cycle.current.flashing = false;
      cycle.current.nextFlashAt = t + 30 + Math.random() * 60; // 30–90s
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

  // Each bird gets its own geometry clone so wing-flap vertex writes
  // don't affect its neighbors.
  const geos = useMemo(() => boids.map(() => makeBirdGeo()), [boids]);
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);

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
    return [
      // S-sweeps: long winding path across the hall, left→right and
      // right→left, descending slightly as they approach the lens.
      mk("s-sweep-LR", 7, [
        [-7, 5.5, -10], [-3, 4.5, -6], [1, 3.5, -2], [-1, 3, 2], [2, 2.7, 3],
      ]),
      mk("s-sweep-RL", 7, [
        [7, 5.5, -10], [3, 4.5, -6], [-1, 3.5, -2], [1, 3, 2], [-2, 2.7, 3],
      ]),
      // Sinuous dive from high-centre to low-near, with lateral wobble.
      mk("s-dive", 7, [
        [0, 7, -9], [3, 5, -6], [-2, 4, -2], [1, 3, 2], [-1, 2.5, 3],
      ]),
      // Reverse: low-near climbing to high-far, zigzagging.
      mk("climb-wind", 7, [
        [2, 2.5, 3], [-1, 3, 0], [1, 4.5, -3], [-2, 5.5, -6], [0, 7, -9],
      ]),
      // Centre-axis zigzag — swings x across while marching forward in z.
      mk("zigzag-z", 7, [
        [-3, 4, -8], [3, 4, -5], [-2, 3.5, -2], [1, 3, 1], [-1, 2.7, 3],
      ]),
      // Low path skimming past Venus's left side (Venus at -3.7, 0, 0.4).
      mk("under-venus", 7, [
        [-7, 3, -8], [-5, 2.5, -3], [-4, 2.5, 0], [-2, 2, 3], [1, 2.5, 4],
      ]),
      // High arc above the stage pelmet, sweeping down into audience.
      mk("over-stage", 7, [
        [-5, 7, -10], [-1, 6.5, -7], [2, 6, -4], [0, 5, -1], [-2, 4, 2],
      ]),
      // Deep arc through the back of the hall, wrapping forward-left.
      mk("deep-arc", 7, [
        [6, 6, -10], [2, 5.5, -7], [-1, 4.5, -3], [-3, 3.5, 1], [-2, 3, 3],
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
  // With 8 routes, user sees all 8 dramatic paths before any repeat
  // — over a typical ~20s cycle that's ~2.5 min for a full tour.
  const routeBag = useRef<Route[]>([]);
  const pickRoute = (): Route => {
    if (routeBag.current.length === 0) shuffleAndRefill(routeBag, routes);
    return routeBag.current.shift()!;
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

    for (let i = 0; i < boids.length; i++) {
      const b = boids[i];
      const mesh = meshRefs.current[i];
      if (!mesh) continue;
      b.goal = goal.current;
      b.goalMultiplier = activeMul;
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
