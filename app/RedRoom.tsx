"use client";

import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerspectiveCamera, useTexture } from "@react-three/drei";
import * as THREE from "three";

/* ————————————————————————————————————————————————
   Red Room — real 3D via Three.js / react-three-fiber.

   A small room: chevron floor, three red velvet walls + ceiling,
   a ghost-lit brass lamp at the back, and Venus standing on the
   left. The camera sits at eye level looking slightly down; a
   very mild mouse parallax shifts it without distortion.
   ———————————————————————————————————————————————— */

/* Generate the chevron pattern as a Canvas texture. Because we
   compute each pixel as a pure function of (x, y) — no polygon
   drawing, no stroke rounding, no AA artefacts at stripe edges —
   the pattern is seamless to tile in BOTH axes as long as the
   tile dimensions are integer multiples of the pattern's period. */
function makeChevronTexture(): THREE.CanvasTexture {
  const SIZE = 1024;
  const N_ZIGZAGS = 8; // zigzag cycles across the tile width
  const N_STRIPES = 16; // alternating bands (integer multiple of 2 for seam)
  const STRIPE_H = SIZE / N_STRIPES;
  const PERIOD = SIZE / N_ZIGZAGS;
  const AMP = STRIPE_H * 0.55;

  const cream = [232, 213, 168]; // #e8d5a8
  const wine = [74, 16, 16];      // #4a1010

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
  const imgData = ctx.createImageData(SIZE, SIZE);
  const data = imgData.data;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Triangle wave in x: -1 at x=0, +1 at x=PERIOD/2, -1 at x=PERIOD
      const phase = (x / PERIOD) % 1;
      const tri = Math.abs(phase - 0.5) * 4 - 1;

      // Shift y by the zigzag amplitude, then find stripe index
      const yShifted = y + tri * AMP;
      const stripeIdx = Math.floor(yShifted / STRIPE_H);
      const parity = ((stripeIdx % 2) + 2) % 2; // safe mod for negatives

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
  tex.needsUpdate = true;
  return tex;
}

function Floor() {
  const tex = useMemo(() => makeChevronTexture(), []);
  // Repeat in world space — one canvas tile covers ~4 world units.
  // With plane 28 wide x 50 deep, that's 7 tiles across, 12.5 down.
  tex.repeat.set(7, 12);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, -5]}
      receiveShadow
    >
      <planeGeometry args={[28, 50, 1, 1]} />
      <meshStandardMaterial
        map={tex}
        roughness={0.92}
        metalness={0.02}
      />
    </mesh>
  );
}

function VelvetPanel({
  width = 8,
  height = 8,
  position,
  rotation,
}: {
  width?: number;
  height?: number;
  position: [number, number, number];
  rotation?: [number, number, number];
}) {
  return (
    <mesh position={position} rotation={rotation} receiveShadow>
      <planeGeometry args={[width, height, 32, 1]} />
      <meshStandardMaterial
        color="#4a0a0a"
        roughness={0.95}
        metalness={0.04}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function Walls() {
  return (
    <group>
      {/* Left wall */}
      <VelvetPanel
        width={14}
        height={8}
        position={[-7, 4, -5]}
        rotation={[0, Math.PI / 2, 0]}
      />
      {/* Right wall */}
      <VelvetPanel
        width={14}
        height={8}
        position={[7, 4, -5]}
        rotation={[0, -Math.PI / 2, 0]}
      />
      {/* Back wall */}
      <VelvetPanel
        width={14}
        height={8}
        position={[0, 4, -12]}
      />
      {/* Ceiling */}
      <VelvetPanel
        width={14}
        height={14}
        position={[0, 8, -5]}
        rotation={[Math.PI / 2, 0, 0]}
      />
    </group>
  );
}

function GhostLight() {
  return (
    <group position={[0, 2.2, -7]}>
      {/* Glowing bulb */}
      <mesh>
        <sphereGeometry args={[0.17, 24, 24]} />
        <meshBasicMaterial color="#fff2c6" toneMapped={false} />
      </mesh>
      {/* Bulb halo (larger dim sphere) */}
      <mesh>
        <sphereGeometry args={[0.35, 16, 16]} />
        <meshBasicMaterial
          color="#f0c47c"
          transparent
          opacity={0.28}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* Warm point light */}
      <pointLight
        color="#f0c47c"
        intensity={18}
        distance={22}
        decay={1.6}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      {/* Brass pole */}
      <mesh position={[0, -1.1, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 2.2, 10]} />
        <meshStandardMaterial
          color="#8b6a34"
          metalness={0.75}
          roughness={0.42}
        />
      </mesh>
      {/* Base */}
      <mesh position={[0, -2.22, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.28, 0.12, 20]} />
        <meshStandardMaterial
          color="#4a3518"
          metalness={0.7}
          roughness={0.55}
        />
      </mesh>
    </group>
  );
}

/* Venus — plane with a shader material that keys out the PNG's
   black background at the GPU, preserving marble shadows. */
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
          // Luminance-to-alpha: black becomes transparent, marble stays
          float lum = c.r + c.g + c.b - 0.06;
          if (lum < 0.12) discard;
          // Slight warm tone-match to SEEN's palette
          vec3 warm = c.rgb * vec3(1.0, 0.95, 0.82);
          gl_FragColor = vec4(warm * 0.94, 1.0);
        }
      `,
      transparent: true,
    });
  }, [tex]);

  return (
    <mesh position={[-3.3, 1.7, -2.2]} material={material}>
      <planeGeometry args={[1.8, 2.7]} />
    </mesh>
  );
}

function CameraRig() {
  const cameraRef = useRef<THREE.PerspectiveCamera>(null);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });

  useFrame(({ mouse }) => {
    // Smooth the mouse toward damped target
    target.current.x = mouse.x * 0.35;
    target.current.y = mouse.y * 0.18;
    current.current.x += (target.current.x - current.current.x) * 0.06;
    current.current.y += (target.current.y - current.current.y) * 0.06;

    if (cameraRef.current) {
      cameraRef.current.position.x = current.current.x;
      cameraRef.current.position.y = 1.65 + current.current.y;
      cameraRef.current.lookAt(0, 1.5, -6);
    }
  });

  return (
    <PerspectiveCamera
      ref={cameraRef}
      makeDefault
      position={[0, 1.65, 5.5]}
      fov={52}
      near={0.1}
      far={100}
    />
  );
}

export function RedRoom() {
  return (
    <Canvas
      shadows
      gl={{
        antialias: true,
        alpha: false,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.1,
      }}
      dpr={[1, 2]}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={["#0a0605"]} />
      <fog attach="fog" args={["#0a0605", 8, 24]} />

      <Suspense fallback={null}>
        <CameraRig />

        {/* Very low ambient — just enough so deep shadows aren't black */}
        <ambientLight intensity={0.08} color="#3a1a0a" />

        {/* Fill light from front so the room isn't purely backlit */}
        <directionalLight
          position={[2, 4, 8]}
          intensity={0.18}
          color="#3a2a1a"
        />

        <GhostLight />
        <Floor />
        <Walls />
        <Venus />
      </Suspense>
    </Canvas>
  );
}
