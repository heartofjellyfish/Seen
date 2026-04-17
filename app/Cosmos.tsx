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

  // ————— corridor walls —————

  // 16 pleats around the tunnel. Cosine gives soft light/dark transition.
  float pleatCount = 16.0;
  float pleatCos = cos(phi * pleatCount);
  float pleatLight = pow((pleatCos + 1.0) * 0.5, 1.6);

  // Alternating depth rings, softened so boundaries aren't harsh
  float ringPhase = fract(depth * 0.55);
  float ring = smoothstep(0.0, 0.08, ringPhase)
             * smoothstep(0.5, 0.42, ringPhase);

  // Darker crease band repeating in depth (a thin shadow between rings)
  float creasePhase = fract(depth * 0.55 + 0.5);
  float crease = smoothstep(0.0, 0.03, creasePhase)
               * smoothstep(0.06, 0.03, creasePhase);

  // Wall palette — warm amber
  vec3 wallShadow = vec3(0.07, 0.025, 0.015);
  vec3 wallMid = vec3(0.34, 0.16, 0.08);
  vec3 wallLit = vec3(0.72, 0.42, 0.20);

  vec3 wallCol = mix(wallShadow, wallMid, pleatLight);
  wallCol = mix(wallCol, wallLit, ring * pleatLight * 0.9);
  wallCol -= vec3(0.06, 0.02, 0.01) * crease;

  // Pleat highlight on the crests — thin bright line
  float crest = smoothstep(0.88, 1.0, pleatCos);
  wallCol += vec3(0.95, 0.68, 0.32) * crest * ring * 0.55;

  // Depth falloff — far is darker
  float depthFade = exp(-depth * 0.045);
  wallCol *= depthFade;

  // Ease the wall fades softly toward the bright core and the outer vignette
  float tunnelMask = smoothstep(0.09, 0.22, r) * smoothstep(2.1, 0.7, r);
  col += wallCol * tunnelMask;

  // ————— core light at the end of the corridor —————

  float pulse = 0.86 + 0.14 * sin(t * 0.32);
  col += vec3(0.95, 0.55, 0.22) * exp(-r * 5.2) * 0.42 * pulse;
  col += vec3(1.0, 0.92, 0.72) * exp(-r * 13.5) * 0.5 * pulse;

  // ————— particles emerging from the depth —————

  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float seed = fi * 0.413 + 0.127;
    // Each particle cycles on its own phase (~10s period)
    float phase = fract(t * 0.095 + seed);

    // Radial growth: starts near center, accelerates outward (ease-in)
    float pr = phase * phase * 1.35 + 0.06;
    // Angular position: stable with tiny wobble
    float pa = seed * 6.2832 + t * 0.04 + sin(t * 0.6 + seed * 11.0) * 0.18;

    vec2 ppos = vec2(cos(pa), sin(pa)) * pr;
    float d = distance(uv, ppos);

    float size = 0.008 + phase * 0.024;
    float b = smoothstep(size, 0.0, d);
    // Fade in from center, fade out before hitting the edge
    b *= smoothstep(0.0, 0.12, phase) * smoothstep(1.0, 0.72, phase);
    b *= 0.9 - phase * 0.25;

    col += vec3(0.95, 0.78, 0.48) * b;
    // Tiny bright kernel
    float bKernel = smoothstep(size * 0.35, 0.0, d);
    col += vec3(1.0, 0.95, 0.75) * bKernel * 0.55;
  }

  // ————— fine grain on walls (star-dust texture) —————

  vec2 grid = vec2(phi * 32.0, depth * 9.0);
  vec2 ig = floor(grid);
  vec2 fg = fract(grid);
  float h = hash(ig);
  if (h > 0.93 && tunnelMask > 0.3) {
    float d = length(fg - 0.5);
    float g = smoothstep(0.18, 0.0, d) * (h - 0.93) * 10.0;
    col += vec3(0.55, 0.33, 0.16) * g * depthFade * 0.45;
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
