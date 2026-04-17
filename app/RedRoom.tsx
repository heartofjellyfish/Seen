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
  // Coarser repeat — each tile covers ~9 world units instead of ~3.5.
  // Visible chevrons are roughly 2.5x bigger than before.
  tex.repeat.set(3, 6);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, -8]}
      receiveShadow
    >
      <planeGeometry args={[28, 48, 1, 1]} />
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
  color = "#3a0505",
  sheenColor = "#9a1a1a",
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
        roughness={0.95}
        metalness={0}
        sheen={1}
        sheenColor={sheenColor}
        sheenRoughness={0.35}
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
        width={28}
        height={11}
        position={[0, 5.5, -22]}
        pleatCount={18}
        pleatDepth={0.2}
      />
      {/* Left wall */}
      <CurtainPanel
        width={36}
        height={11}
        position={[-14, 5.5, -8]}
        rotation={[0, Math.PI / 2, 0]}
        pleatCount={22}
        pleatDepth={0.22}
      />
      {/* Right wall */}
      <CurtainPanel
        width={36}
        height={11}
        position={[14, 5.5, -8]}
        rotation={[0, -Math.PI / 2, 0]}
        pleatCount={22}
        pleatDepth={0.22}
      />
      {/* Ceiling — darker red, flat */}
      <mesh
        position={[0, 11, -8]}
        rotation={[Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[28, 36]} />
        <meshStandardMaterial
          color="#1a0404"
          roughness={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// ————— raised stage + its own proscenium curtains —————

function Stage() {
  const stageZ = -18;
  const stageW = 9;
  const stageD = 3.5;
  const stageH = 0.9;
  const curtainHeight = 7.5;
  const pelmetHeight = 0.9;

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
          color="#2a0404"
          roughness={0.95}
          metalness={0}
          sheen={1}
          sheenColor="#6a1010"
          sheenRoughness={0.35}
        />
      </mesh>

      {/* Stage curtain — two pleated panels meeting in the middle */}
      <CurtainPanel
        width={stageW / 2 + 0.3}
        height={curtainHeight}
        position={[-stageW / 4 + 0.15, stageH + curtainHeight / 2, stageD / 2]}
        pleatCount={14}
        pleatDepth={0.15}
        color="#4a0808"
        sheenColor="#a01818"
      />
      <CurtainPanel
        width={stageW / 2 + 0.3}
        height={curtainHeight}
        position={[stageW / 4 - 0.15, stageH + curtainHeight / 2, stageD / 2]}
        pleatCount={14}
        pleatDepth={0.15}
        color="#4a0808"
        sheenColor="#a01818"
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

// ————— Venus — decor in the left corner —————

function Venus() {
  const tex = useTexture("/venus.png", (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
  }) as THREE.Texture;

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(uMap, vUv);
          float lum = c.r + c.g + c.b - 0.06;
          if (lum < 0.12) discard;
          vec3 warm = c.rgb * vec3(1.0, 0.95, 0.82);
          gl_FragColor = vec4(warm * 0.94, 1.0);
        }
      `,
      transparent: true,
    });
  }, [tex]);

  return (
    <mesh position={[-7, 1.35, -6]} material={material}>
      <planeGeometry args={[1.8, 2.7]} />
    </mesh>
  );
}

// ————— camera with a gentle mouse-parallax rig —————

function CameraRig() {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });

  useFrame(({ mouse }) => {
    target.current.x = mouse.x * 0.35;
    target.current.y = mouse.y * 0.2;
    current.current.x += (target.current.x - current.current.x) * 0.06;
    current.current.y += (target.current.y - current.current.y) * 0.06;

    if (cameraRef.current) {
      cameraRef.current.position.x = current.current.x;
      cameraRef.current.position.y = 1.7 + current.current.y;
      cameraRef.current.lookAt(0, 2.5, -18);
    }
  });

  return (
    <PerspectiveCamera
      ref={cameraRef}
      makeDefault
      position={[0, 1.7, 8]}
      fov={52}
      near={0.1}
      far={100}
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
      <color attach="background" args={["#150606"]} />
      <fog attach="fog" args={["#150606", 18, 50]} />

      <Suspense fallback={null}>
        <CameraRig />

        {/* Room lights — no ghost light any more; the room is
            generally lit like a theater's house lights between acts.
            Warm, dim-ish, enough to see the curtains everywhere. */}
        <ambientLight intensity={0.45} color="#5a2a18" />

        {/* Front-top fill — simulates ceiling fixtures in the house */}
        <directionalLight
          position={[0, 8, 6]}
          intensity={0.75}
          color="#f0c480"
        />

        {/* Back fill from the audience behind us, warms silhouettes */}
        <directionalLight
          position={[0, 4, 14]}
          intensity={0.35}
          color="#d4a363"
        />

        {/* Side rim from the right, brushes Venus and the side curtain */}
        <directionalLight
          position={[10, 5, 0]}
          intensity={0.28}
          color="#c88a3a"
        />

        <Floor />
        <Walls />
        <Stage />
        <Venus />
      </Suspense>
    </Canvas>
  );
}
