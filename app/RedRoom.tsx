"use client";

import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerspectiveCamera, useTexture } from "@react-three/drei";
import * as THREE from "three";

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

  return (
    <mesh
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
      {/* Left wall */}
      <CurtainPanel
        width={28}
        height={9}
        position={[-11, 4.5, -6]}
        rotation={[0, Math.PI / 2, 0]}
        pleatCount={18}
        pleatDepth={0.2}
      />
      {/* Right wall */}
      <CurtainPanel
        width={28}
        height={9}
        position={[11, 4.5, -6]}
        rotation={[0, -Math.PI / 2, 0]}
        pleatCount={18}
        pleatDepth={0.2}
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
      {/* Stage floor trim — a thin brass strip at the front edge */}
      <mesh position={[0, stageH + 0.03, stageD / 2]} castShadow>
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
  //   y=0 to 0.31       → 3D marble pedestal
  //   y=0.31 to 2.71    → Venus body plane (feet at bottom, head at top)
  return (
    <group position={[-5.5, 0, -4.5]}>
      {/* Ground shadow */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <planeGeometry args={[3.2, 1.8]} />
        <meshBasicMaterial
          map={shadowTex}
          transparent
          depthWrite={false}
          opacity={0.98}
        />
      </mesh>

      {/* 3D marble pedestal — cream stone, picks up scene lighting */}
      <mesh position={[0, 0.155, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.9, 0.31, 0.55]} />
        <meshStandardMaterial
          color="#b0997a"
          roughness={0.82}
          metalness={0.02}
        />
      </mesh>
      {/* Thin darker base line where pedestal meets floor */}
      <mesh position={[0, 0.005, 0]} castShadow>
        <boxGeometry args={[0.95, 0.01, 0.6]} />
        <meshStandardMaterial color="#4a3e30" roughness={0.9} />
      </mesh>

      {/* Altar uplight — a small warm point-light at the front of
          the pedestal, washing upward over the statue. Turns her
          from a dim silhouette into a visible piece of marble.
          Short distance so it doesn't bleed onto the curtains. */}
      <pointLight
        position={[0, 0.4, 0.35]}
        color="#ffd8a0"
        intensity={7}
        distance={4.5}
        decay={1.4}
      />
      {/* Visible tiny brass cap at the uplight origin so the light
          has a believable source in the scene */}
      <mesh position={[0, 0.35, 0.35]} castShadow>
        <cylinderGeometry args={[0.08, 0.09, 0.05, 16]} />
        <meshStandardMaterial
          color="#8b6a34"
          metalness={0.7}
          roughness={0.45}
          emissive="#f0c47c"
          emissiveIntensity={0.6}
        />
      </mesh>

      {/* Venus body. MeshStandardMaterial gives her full PBR
          lighting — every torchiere, sconce, altar spot, and the
          hemisphere wash will affect her. Black-background keying
          is done via an onBeforeCompile hook that injects a
          luminance-based discard right after the map is sampled —
          avoids the alphaMap-goes-semi-transparent bug that
          alphaMap + transparent=true was causing. */}
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

        {/* Byzantine layer — a warm red environmental wash, the room
            'glows' from all directions. Not too bright, but enough
            that no surface falls completely into black. */}
        <hemisphereLight args={["#7a2828", "#2a0808", 0.75]} />
        <ambientLight intensity={0.22} color="#6a2020" />

        {/* Altar layer — a gentle broad spot on the stage curtain.
            Reads as 'altar highlight' more than a harsh beam. */}
        <AltarSpot />

        {/* La Tour layer — distributed warm sources across the room.
            Each one is a visible fixture with its own flicker. */}
        <Torchiere position={[-6.5, 0, -10]} />
        <Torchiere position={[6.5, 0, -10]} />
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
        <Walls />
        <Stage />
        <Venus />
      </Suspense>
    </Canvas>
  );
}
