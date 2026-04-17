"use client";

import { useEffect, useRef } from "react";
import styles from "./stage.module.css";

/**
 * An amber velvet corridor receding into depth.
 *
 * Fragment shader draws a tunnel projection (depth = k/r), with
 * 16 vertical pleats running into the distance and soft alternating
 * rings that slide toward the viewer — as if we are walking slowly
 * down a backstage corridor of curtains. A dim amber core burns
 * where the corridor ends, pulsing like a heart. Every few seconds
 * a single warm mote emerges from that depth and drifts outward,
 * growing as it nears the edge of vision — the hint of someone
 * walking toward us from far away.
 *
 * Mouse position shifts the corridor's vanishing point — turning
 * the viewer's head in a still body. Progress (0..1) tightens and
 * accelerates the advance as fame approaches.
 *
 * Respects prefers-reduced-motion: renders a single still frame.
 */

const VS = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS = `
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform float u_progress;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2d(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);

  // Mouse parallax — vanishing point drifts opposite to head motion
  uv += u_mouse * 0.14;

  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float t = u_time;

  // Tunnel depth from radial position (classic 1/r projection).
  // Clamp to avoid singularity at the exact center.
  float rSafe = max(r, 0.02);
  // Base depth = actual distance from viewer (stable, only a function of r).
  // Used for lighting falloff so brightness doesn't drift over time.
  float baseDepth = 0.45 / rSafe;

  // Flowing depth = base + time. Only used to advance the ring pattern.
  float speed = 0.75 + u_progress * u_progress * 0.6;
  float depth = baseDepth + t * speed;

  // Angular rotation — slow spin down the corridor + a little mouse yaw
  float phi = a + t * 0.11 + u_mouse.x * 0.28;

  vec3 col = vec3(0.0);

  // ————— ink-blot cosmos: rings of organic painterly dots —————
  //
  // Tunnel structure is still concentric rings (so perspective rush
  // survives), but each ring is populated by scattered bone-cream
  // dots on deep indigo. Each (ring, slot) cell hosts one dot at a
  // hash-based offset, with hash-based size, shape squash, and a 35%
  // chance of being empty. Dot boundaries are noise-distorted so
  // every edge looks like wet ink soaking into paper.

  const float PI = 3.14159265;
  const float RING_FREQ = 1.2;
  const float ANGULAR_SLOTS = 18.0;

  float bandIdx = floor(depth * RING_FREQ);
  float bandPos = fract(depth * RING_FREQ);

  float angPhase = (phi / (2.0 * PI)) * ANGULAR_SLOTS;
  float slotIdx = floor(angPhase);
  float slotLocal = fract(angPhase);

  vec2 cell = vec2(bandIdx, slotIdx);
  float h1 = hash(cell);
  float h2 = hash(cell + vec2(11.1, 7.3));
  float h3 = hash(cell + vec2(23.7, 13.9));
  float h4 = hash(cell + vec2(37.3, 19.1));
  float h5 = hash(cell + vec2(41.7, 29.3));

  // Dot center anchored inside [0.32, 0.68] so it doesn't bleed into
  // neighbouring cells even at max radius.
  vec2 dotCenter = vec2(0.32 + h1 * 0.36, 0.32 + h2 * 0.36);

  float dotRadius = 0.14 + h3 * 0.18;
  float squash = 0.7 + h4 * 0.6;

  vec2 pixelPos = vec2(bandPos, slotLocal);
  vec2 relPos = pixelPos - dotCenter;
  relPos.x /= squash;
  relPos.y *= squash;
  float dist = length(relPos);

  // Painterly edge — two octaves of noise soak the boundary
  float edgeN = noise2d(pixelPos * 22.0 + cell * 3.3) - 0.5;
  edgeN += (noise2d(pixelPos * 48.0 + cell * 7.1) - 0.5) * 0.5;
  float inked = smoothstep(
    dotRadius + 0.025,
    dotRadius - 0.015,
    dist + edgeN * 0.05
  );

  // ~35% of cells have no dot — the scatter is sparse
  float present = step(0.35, h5);
  inked *= present;

  // Palette — deep indigo + bone cream, with a drifting warm hint
  vec3 indigoDeep   = vec3(0.05, 0.06, 0.18);
  vec3 indigo       = vec3(0.11, 0.13, 0.36);
  vec3 creamDot     = vec3(0.92, 0.85, 0.66);
  vec3 creamEdge    = vec3(0.45, 0.38, 0.24);

  // Background: indigo with a subtle orbit — hints there's a warm
  // light somewhere in the void (the ghost light ahead)
  float orbit = cos(phi - t * 0.3) * 0.5 + 0.5;
  vec3 base = mix(indigoDeep, indigo, 0.35 + orbit * 0.55);
  base += vec3(0.025, 0.018, 0.0) * orbit;

  // Dot: cream with a painted darker rim just inside the edge
  float dotCore = smoothstep(dotRadius * 0.55, 0.0, dist + edgeN * 0.05);
  vec3 dotCol = mix(creamEdge, creamDot, dotCore);

  vec3 wallCol = mix(base, dotCol, inked);

  // Depth fade — driven by baseDepth so brightness is stable over time.
  float depthFade = exp(-baseDepth * 0.06);
  wallCol *= depthFade;

  // ————— paper grain (risograph / screen-print texture) —————
  //
  // Two layers of hash noise pinned to screen coordinates — the paper
  // itself doesn't move, only the printed rings on it do. Tinted warm
  // so grain still reads inside SEEN's palette.

  vec2 gPos = gl_FragCoord.xy;
  float gFine = hash(gPos * 1.6) - 0.5;
  float gCoarse = hash(floor(gPos * 0.35)) - 0.5;
  float grain = gFine * 0.14 + gCoarse * 0.07;
  // Grain tinted slightly cool to sit inside the indigo field
  wallCol += vec3(grain * 0.9, grain * 0.95, grain * 1.15) * depthFade;

  // Smooth mask at center and outer edge
  float tunnelMask = smoothstep(0.08, 0.2, r) * smoothstep(2.2, 0.6, r);
  col += wallCol * tunnelMask;

  // ————— outer vignette —————

  col *= smoothstep(2.3, 0.2, r);
  col *= 0.95;

  gl_FragColor = vec4(col, 1.0);
}
`;

export function Cosmos({ progress = 0 }: { progress?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(progress);

  // Keep progress ref fresh for the animation loop
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error("[cosmos] shader compile:", gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
      }
      return s;
    };

    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[cosmos] program link:", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const posLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(prog, "u_time");
    const uRes = gl.getUniformLocation(prog, "u_resolution");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");
    const uProgress = gl.getUniformLocation(prog, "u_progress");

    // ————— mouse tracking (window-level, damped) —————

    const mouseTarget = { x: 0, y: 0 };
    const mouseSmooth = { x: 0, y: 0 };
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      mouseTarget.x = (e.clientX / w) * 2 - 1;
      mouseTarget.y = -((e.clientY / h) * 2 - 1);
    };
    const onLeave = () => {
      mouseTarget.x = 0;
      mouseTarget.y = 0;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);

    // ————— resize —————

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // ————— animation loop —————

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let rafId = 0;
    const t0 = performance.now();
    const frame = () => {
      // Damp the mouse toward target
      const damp = 0.06;
      mouseSmooth.x += (mouseTarget.x - mouseSmooth.x) * damp;
      mouseSmooth.y += (mouseTarget.y - mouseSmooth.y) * damp;

      const t = (performance.now() - t0) / 1000;
      gl.uniform1f(uTime, t);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform2f(uMouse, mouseSmooth.x, mouseSmooth.y);
      gl.uniform1f(uProgress, progressRef.current);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!reducedMotion) rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);

    const onVis = () => {
      if (document.hidden) {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
      } else if (!reducedMotion && !rafId) {
        rafId = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("visibilitychange", onVis);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, []);

  return (
    <div className={styles.cosmos} aria-hidden>
      <canvas ref={canvasRef} className={styles.cosmosCanvas} />
    </div>
  );
}
