"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerspectiveCamera, Sparkles, useGLTF, useAnimations, useTexture } from "@react-three/drei";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import * as THREE from "three";

// Must be called once before any RectAreaLight renders
RectAreaLightUniformsLib.init();

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
  segments = 80,
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
        emissive="#2a0303"
        emissiveIntensity={0.35}
        side={THREE.DoubleSide}
      />
    </mesh>
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

      {/* Stage curtain — two pleated panels meeting in the middle */}
      <CurtainPanel
        width={stageW / 2 + 0.3}
        height={curtainHeight}
        position={[-stageW / 4 + 0.15, stageH + curtainHeight / 2, stageD / 2]}
        pleatCount={14}
        pleatDepth={0.15}
        color="#8a1818"
        sheenColor="#e03030"
      />
      <CurtainPanel
        width={stageW / 2 + 0.3}
        height={curtainHeight}
        position={[stageW / 4 - 0.15, stageH + curtainHeight / 2, stageD / 2]}
        pleatCount={14}
        pleatDepth={0.15}
        color="#8a1818"
        sheenColor="#e03030"
      />

      {/* Tiny inner warm glow as if the stage behind the curtain is lit */}
      <pointLight
        position={[0, stageH + 3, -0.3]}
        color="#d4a363"
        intensity={2.5}
        distance={6}
        decay={2}
      />

      {/* Invisible flicker rim — the candle ring has been replaced
          by a bank of mist, but the warm point lights still flicker
          at their former positions so the illusion of 'something
          burning just behind the fog' survives. */}
      <StageCandleRing stageW={stageW} stageD={stageD} stageH={stageH} />

      <CurtainBleedGlow stageD={stageD} stageH={stageH} />
    </group>
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
    const N_FRONT = 7;
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
    // Distributed along the curtain width + height. Height is
    // biased low so the glows sit where candle flames would be
    // behind them (~y = stageH + 0.5 world).
    const raw: Array<{ x: number; y: number; size: number }> = [
      { x: -5.3, y: 0.4, size: 1.1 },
      { x: -3.2, y: 1.3, size: 1.5 },
      { x: -1.2, y: 0.3, size: 1.0 },
      { x: 0.9, y: 1.1, size: 1.4 },
      { x: 2.9, y: 0.7, size: 1.2 },
      { x: 5.1, y: 1.5, size: 1.1 },
    ];
    return raw.map((p) => ({ ...p, seed: Math.random() * 10 }));
  }, []);
  const matRefs = useRef<Array<THREE.MeshBasicMaterial | null>>(
    Array(patches.length).fill(null),
  );
  useFrame(({ clock }) => {
    for (let i = 0; i < patches.length; i++) {
      const m = matRefs.current[i];
      if (!m) continue;
      const t = clock.elapsedTime + patches[i].seed;
      const flick =
        0.55 + Math.sin(t * 2.3) * 0.22 + Math.sin(t * 5.8 + 0.3) * 0.1;
      m.opacity = Math.max(0, 0.42 * flick);
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
            color="#ffb060"
            transparent
            opacity={0.35}
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
      castShadow
      shadow-mapSize={[1024, 1024]}
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
      count={80}
      // [x, y, z] box centred on position — 9m wide, 5m tall, 12m deep
      scale={[9, 5, 12]}
      position={[0, 2.8, -3]}
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
      {/* Left wall — second block (higher intensity to offset missing stage spill) */}
      <rectAreaLight position={[-10.5, 3.2, -7.0]} rotation={[0,  Math.PI / 2, 0]} width={3} height={5} color="#e8960a" intensity={2} />
      {/* Right wall — near stage */}
      <rectAreaLight position={[10.5,  3.2, -11.5]} rotation={[0, -Math.PI / 2, 0]} width={3} height={5} color="#e8960a" intensity={2} />
      {/* Right wall — second block (higher intensity to offset missing stage spill) */}
      <rectAreaLight position={[10.5,  3.2, -7.0]} rotation={[0, -Math.PI / 2, 0]} width={3} height={5} color="#e8960a" intensity={2} />
    </group>
  );
}

// ————— 4v white bird fly-by —————
// A rare, startling flight: a white stork emerges from the stage wing,
// curves toward the camera along a CatmullRom spline, almost hits the
// lens, then swerves past the right and exits. Uses three.js's
// example Stork.glb (served from /public). One instance, reused.
//
// Timing: first appearance ~18–32s in, then every 55–135s. Flight
// duration ~2.6–3.4s, with an ease-out so the bird accelerates into
// the camera — the perspective blow-up in the final ~0.3s is the
// spectacle.
//
// Materials: all meshes are replaced with a cream-white
// MeshBasicMaterial (toneMapped off) so the bird reads as a clean,
// self-lit apparition against the red velvet — if you leave the PBR
// material in, the red hemisphere + emissive walls stain the bird
// dark red and the silhouette disappears into the curtain.

function Bird() {
  const groupRef = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF("/Stork.glb");
  const { actions } = useAnimations(animations, scene);

  // Grab the flap clip so we can drive its timeScale dynamically in
  // useFrame — the flap accelerates as the bird closes on the camera.
  const flapAction = useRef<THREE.AnimationAction | null>(null);
  useEffect(() => {
    const first = Object.values(actions)[0];
    if (first) {
      first.reset().play();
      flapAction.current = first;
    }
  }, [actions]);

  // Give the bird form. Flat MeshBasicMaterial reads as a cartoon
  // ghost silhouette — no volume, no wing shape. Instead use
  // MeshStandardMaterial with a strong cream emissive so:
  //   • the bird is self-lit enough to hold a white read against
  //     the red hemisphere stain,
  //   • but scene lights still shade the body, so you can see the
  //     breast, wing undersides, and depth of the flap pose.
  useEffect(() => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = new THREE.MeshStandardMaterial({
        color: "#d8cdb2",         // slightly warm off-white base
        emissive: "#f4ecd6",      // cream self-light
        emissiveIntensity: 1.1,   // overpowers the red ambient
        roughness: 0.55,
        metalness: 0.0,
        side: THREE.FrontSide,
      });
      mesh.material = mat;
    });
  }, [scene]);

  // Spline path. Start in the stage wing (behind back curtain z=-16,
  // in front of stage curtain z=-10.75), descend toward camera which
  // sits at (0, 1.65, 6). The "near-miss" point is (0.3, 2.5, 1.5) —
  // head-on to the camera, ~4.5m away. Then a last-second swerve to
  // the right (positive x) and exit behind camera.
  // Camera sits at (0, 1.65, 6) looking at (0, 3, -13) — line of sight
  // climbs very slightly upward. To keep the bird centered in view as
  // it closes on the camera, stay near x≈0 and y≈2.0–2.6 through the
  // approach, and only swerve sideways in the last 20% of the journey.
  const curve = useMemo(
    () =>
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(3.5, 5.8, -12),   // stage wing, high
        new THREE.Vector3(1.6, 4.4, -6.5),  // still far, descending
        new THREE.Vector3(0.4, 3.1, -1),    // committed dive toward camera
        new THREE.Vector3(0.0, 2.3, 2.5),   // head-on, ~3.5m out
        new THREE.Vector3(0.05, 1.95, 4.6), // nearly touching lens (1.4m)
        new THREE.Vector3(0.6, 1.75, 5.8),  // last-frame hard swerve right
        new THREE.Vector3(2.6, 1.5, 8.8),   // gone past camera
      ]),
    [],
  );

  // Helper reusable vectors so we don't allocate per frame.
  const posVec = useRef(new THREE.Vector3()).current;
  const tanVec = useRef(new THREE.Vector3()).current;
  const lookVec = useRef(new THREE.Vector3()).current;

  const state = useRef({
    flying: false,
    startTime: 0,
    duration: 3.0,
    nextFlightAt: 2 + Math.random() * 3, // first appearance 2–5s in
    mirror: 1 as 1 | -1,
  });

  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const t = clock.elapsedTime;
    const s = state.current;

    if (!s.flying && t >= s.nextFlightAt) {
      s.flying = true;
      s.startTime = t;
      s.duration = 2.1 + Math.random() * 0.5; // 2.1–2.6s, tight
      s.mirror = (Math.random() > 0.5 ? 1 : -1) as 1 | -1;
    }

    if (!s.flying) {
      groupRef.current.visible = false;
      return;
    }

    const raw = (t - s.startTime) / s.duration;
    if (raw >= 1) {
      s.flying = false;
      s.nextFlightAt = t + 8 + Math.random() * 7; // 8–15s between fly-bys
      groupRef.current.visible = false;
      return;
    }

    // Sharp ease-in: bird hangs far-out for most of the flight, then
    // detonates through the last ~25% of the path straight at the
    // lens. Exponent 4.0 is much more aggressive than a standard
    // ease-out — this is where the thriller jump lives.
    const p = 1 - Math.pow(1 - raw, 4.0);

    // Wingbeat scales with approach — slow, gliding flaps when far,
    // frantic panic flaps at the moment of near-miss.
    if (flapAction.current) {
      flapAction.current.timeScale = 1.3 + 2.2 * p;
    }

    curve.getPoint(p, posVec);
    curve.getTangent(p, tanVec);

    groupRef.current.visible = true;
    groupRef.current.position.set(
      posVec.x * s.mirror,
      posVec.y,
      posVec.z,
    );

    // Face direction of travel
    lookVec.copy(posVec).add(tanVec);
    lookVec.x *= s.mirror;
    groupRef.current.lookAt(lookVec);

    // No opacity fading — the bird just appears/disappears. Entry
    // is behind the stage area so emergence reads as "coming out of
    // the curtain", and exit is behind the camera so there's nothing
    // to fade.
  });

  return (
    <group ref={groupRef} visible={false}>
      <primitive object={scene} scale={0.02} />
    </group>
  );
}

useGLTF.preload("/Stork.glb");

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

  worldHalf = new THREE.Vector3(4, 2, 3.5);
  neighborhoodRadius = 2.5;
  maxSpeed = 0.035;
  maxSteerForce = 0.0012;
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
    steer.multiplyScalar(5 / dsq);
    this.accel.add(steer);
  }

  private doFlock(flock: Boid[]) {
    if (this.goal) {
      const steer = new THREE.Vector3()
        .copy(this.goal)
        .sub(this.position)
        .multiplyScalar(0.005);
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
    const steer = new THREE.Vector3();
    if (count > 0) {
      posSum.divideScalar(count);
      steer.copy(posSum).sub(this.position);
      const l = steer.length();
      if (l > this.maxSteerForce) steer.multiplyScalar(this.maxSteerForce / l);
    }
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
    return posSum;
  }
}

function Flock() {
  const NUM = 32;

  const boids = useMemo(() => {
    const list: Boid[] = [];
    for (let i = 0; i < NUM; i++) {
      const b = new Boid();
      b.position.set(
        (Math.random() - 0.5) * 2 * b.worldHalf.x,
        (Math.random() - 0.5) * 2 * b.worldHalf.y,
        (Math.random() - 0.5) * 2 * b.worldHalf.z,
      );
      b.velocity.set(
        (Math.random() - 0.5) * 0.02,
        (Math.random() - 0.5) * 0.02,
        (Math.random() - 0.5) * 0.02,
      );
      list.push(b);
    }
    return list;
  }, []);

  // Each bird gets its own geometry clone so wing-flap vertex writes
  // don't affect its neighbors.
  const geos = useMemo(() => boids.map(() => makeBirdGeo()), [boids]);
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(() => {
    for (let i = 0; i < boids.length; i++) {
      const b = boids[i];
      const mesh = meshRefs.current[i];
      if (!mesh) continue;
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
    <group position={[0, 6, -10.5]}>
      {boids.map((_, i) => (
        <mesh
          key={i}
          geometry={geos[i]}
          ref={(m) => {
            meshRefs.current[i] = m;
          }}
        >
          <meshStandardMaterial
            color="#d8cdb2"
            emissive="#efe6cb"
            emissiveIntensity={0.55}
            side={THREE.DoubleSide}
            roughness={0.7}
          />
        </mesh>
      ))}
    </group>
  );
}

// ————— main scene —————

export function RedRoom() {

  return (
    <Canvas
      shadows
      gl={{
        antialias: true,
        alpha: false,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      }}
      dpr={[1, 2]}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={["#220808"]} />
      <fog attach="fog" args={["#220808", 20, 60]} />

      <Suspense fallback={null}>
        <CameraRig />

        <hemisphereLight args={["#8a3030", "#2a0808", 1.05]} />
        <ambientLight intensity={0.38} color="#7a2828" />
        <AltarSpot />

        {/* Soft amber area lights behind the side velvet wall curtains */}
        <WallCurtainLights />

        <SideSconce position={[-10, 5.5, -4]} />
        <SideSconce position={[10, 5.5, -4]} />
        <SideSconce position={[-10, 3, -11]} />
        <SideSconce position={[10, 3, -11]} />

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
        <Bird />
      </Suspense>
    </Canvas>
  );
}
