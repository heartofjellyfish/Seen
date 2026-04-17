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
  // Base depth = actual distance from viewer (stable, only a function of r).
  // Used for lighting falloff so brightness doesn't drift over time.
  float baseDepth = 0.45 / rSafe;

  // Flowing depth = base + time. Only used to advance the ring pattern.
  float speed = 0.75 + u_progress * u_progress * 0.6;
  float depth = baseDepth + t * speed;

  // Angular rotation — slow spin down the corridor + a little mouse yaw
  float phi = a + t * 0.11 + u_mouse.x * 0.28;

  vec3 col = vec3(0.0);

  // ————— concentric rings with a paper/ribbon feel —————
  //
  // Pure circles (no angular modulation). Each ring uses an asymmetric
  // ribbon profile — peak shifted slightly so the band reads as a folded
  // strip of paper catching light from one side. Crisp dark fold lines
  // at band boundaries separate rings like stamped creases. Colours are
  // warm bone against deep wine — desaturated, print-like, not orange.

  const float RING_FREQ = 1.4;
  const float PI = 3.14159265;

  float bandIdx = floor(depth * RING_FREQ);
  float bandPos = fract(depth * RING_FREQ);

  // ——— rope structure ———
  // Each ring's surface is covered by several strands spiralling
  // along its length. fiberCoord runs along the rope's "skin" on a
  // diagonal: moving around the ring (phi) AND across the tube
  // cross-section (bandPos) both advance it, which draws the twist.

  const float STRAND_COUNT = 4.0;
  const float TWIST = 0.24;

  float fiberCoord = (bandPos + phi * TWIST) * STRAND_COUNT;
  float strandPos = fract(fiberCoord);

  // Each strand has its own cylindrical cross-section (little tubes
  // making up the big rope)
  float fiberBump = sin(strandPos * PI);

  // Dark groove between strands — crisp, narrow, dominant
  float grooveDist = min(strandPos, 1.0 - strandPos);
  float groove = smoothstep(0.07, 0.0, grooveDist);

  // Overall ring cross-section (subtle — the rope as a whole still has
  // some curvature, but fibers do most of the shading now)
  float ringCurve = sin(bandPos * PI);

  // Combined rope shade
  float rope = mix(0.35, 1.0, ringCurve) * (0.35 + 0.65 * fiberBump);
  rope *= 1.0 - groove * 0.85;

  // Crisp fold at the very band edge (separates neighbouring rings)
  float fold = smoothstep(0.0, 0.025, bandPos) * smoothstep(1.0, 0.975, bandPos);

  float parity = mod(bandIdx, 2.0);

  // Palette — warm bone vs deep wine, both desaturated
  vec3 creamLight = vec3(0.90, 0.80, 0.58);
  vec3 creamShadow = vec3(0.26, 0.16, 0.08);
  vec3 darkLight = vec3(0.22, 0.10, 0.06);
  vec3 darkShadow = vec3(0.05, 0.018, 0.01);
  vec3 foldInk = vec3(0.015, 0.005, 0.003);
  vec3 grooveInk = vec3(0.02, 0.008, 0.004);

  vec3 lightStrand = mix(creamShadow, creamLight, rope);
  vec3 darkStrand  = mix(darkShadow, darkLight, rope * 0.7);

  vec3 wallCol = mix(darkStrand, lightStrand, parity);

  // Dark the grooves explicitly (not just scaled)
  wallCol = mix(wallCol, grooveInk, groove * 0.6);

  // Stamp the fold crease at ring boundaries
  wallCol = mix(foldInk, wallCol, fold);

  // Directional tilt orbiting the axis — a light source racing around
  float rotTilt = cos(phi - t * 0.45) * 0.2;
  wallCol *= 1.0 + rotTilt;

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
  wallCol += vec3(grain * 1.1, grain * 0.9, grain * 0.75) * depthFade;

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
