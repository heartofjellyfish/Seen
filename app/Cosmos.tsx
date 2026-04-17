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
  float depth = 0.45 / rSafe;

  // Forward motion — we are walking in. Progress accelerates slightly.
  float speed = 0.42 + u_progress * u_progress * 0.45;
  depth += t * speed;

  // Angular rotation — slow spin down the corridor + a little mouse yaw
  float phi = a + t * 0.11 + u_mouse.x * 0.28;

  vec3 col = vec3(0.0);

  // ————— zigzag concentric bands, spiraling into depth —————
  //
  // Rings of alternating light/dark, each ring's inner/outer edge
  // wobbled by a cosine of angle. The wobble shifts angularly with
  // depth, which creates the spiral-twist illusion between adjacent
  // rings (teeth appear to interlock).

  const float TEETH = 20.0;      // number of zigzag points per ring
  const float RING_FREQ = 0.46;  // how densely rings pack in depth
  const float TWIST = 1.6;       // how much teeth shift per depth unit

  float edgeWave = cos(phi * TEETH + depth * TWIST) * 0.18;
  float depthMod = depth + edgeWave;

  float bandIdx = floor(depthMod * RING_FREQ);
  float bandPos = fract(depthMod * RING_FREQ);

  float parity = mod(bandIdx, 2.0);
  vec3 lightBand = vec3(0.70, 0.42, 0.18);
  vec3 darkBand = vec3(0.045, 0.018, 0.010);
  vec3 wallCol = (parity > 0.5) ? lightBand : darkBand;

  // Rib shading — darken the edges of each band so bands look 3D
  float edgeSoft = smoothstep(0.0, 0.12, bandPos) * smoothstep(1.0, 0.88, bandPos);
  wallCol *= 0.55 + 0.45 * edgeSoft;

  // Thin amber highlight running along the inner edge of light bands
  float innerEdge = smoothstep(0.02, 0.0, abs(bandPos - 0.1)) * parity;
  wallCol += vec3(0.95, 0.66, 0.3) * innerEdge * 0.25;

  // Depth fade
  float depthFade = exp(-depth * 0.058);
  wallCol *= depthFade;

  // Smooth mask at center and outer edge
  float tunnelMask = smoothstep(0.08, 0.2, r) * smoothstep(2.2, 0.6, r);
  col += wallCol * tunnelMask;

  // ————— fine dust grain on walls —————

  vec2 grid = vec2(phi * 36.0, depth * 11.0);
  vec2 ig = floor(grid);
  vec2 fg = fract(grid);
  float h = hash(ig);
  if (h > 0.94 && tunnelMask > 0.3) {
    float d = length(fg - 0.5);
    float g = smoothstep(0.16, 0.0, d) * (h - 0.94) * 11.0;
    col += vec3(0.55, 0.33, 0.16) * g * depthFade * 0.4;
  }

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
