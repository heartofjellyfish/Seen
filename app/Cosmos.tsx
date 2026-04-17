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

  // Subtle mouse parallax
  uv += u_mouse * 0.08;

  float r = length(uv);
  float theta = atan(uv.y, uv.x);
  float t = u_time;

  // ————— zigzag chevron tunnel —————
  //
  // A tunnel whose wall is papered in Red Room chevron. From the
  // viewer's POV this reads as concentric rings with zigzag edges
  // receding toward the vanishing point. The rings flow forward
  // (toward us) so new ones keep emerging from the centre; the
  // whole tunnel slowly rotates around its axis. Alternate rings
  // are cream and wine — the chevron colour scheme. Depth attenuates
  // brightness so the rings fade into the black centre where the
  // ghost light will sit.

  const float PI = 3.14159265;
  const float TEETH = 22.0;        // more, smaller teeth — no mandala lock
  const float RING_FREQ = 1.5;     // denser rings so perspective compresses properly
  const float ZIGZAG_AMP = 0.14;   // teeth bite subtly; rings stay recognisable as rings

  float rSafe = max(r, 0.02);
  float baseDepth = 0.5 / rSafe;

  // Forward flow — rings rush toward viewer
  float flowSpeed = 0.38 + u_progress * u_progress * 0.25;
  float depth = baseDepth + t * flowSpeed;

  // Slow rotation around the tunnel axis
  float rotSpeed = 0.045;
  float phi = theta + t * rotSpeed + u_mouse.x * 0.12;

  // Triangular wave in angular direction — the zigzag
  float teethPhase = phi * TEETH / (2.0 * PI);
  float teethWave = abs(fract(teethPhase) * 2.0 - 1.0); // 0 at valley, 1 at peak

  // Band boundaries are depth + triangular-wave offset in angle
  float effectiveDepth = depth + teethWave * ZIGZAG_AMP;
  float bandIdx = floor(effectiveDepth * RING_FREQ);
  float bandPos = fract(effectiveDepth * RING_FREQ);

  // Alternate ring colours
  float parity = mod(bandIdx, 2.0);

  vec3 cream = vec3(0.90, 0.80, 0.55);
  vec3 wine  = vec3(0.28, 0.075, 0.075);

  // Soft edge between rings — smoothstep in bandPos to avoid crawling
  // aliasing as the pattern flows
  float edgeSoft = smoothstep(0.0, 0.025, bandPos)
                 * smoothstep(1.0, 0.975, bandPos);
  vec3 bandCol = mix(wine, cream, parity);
  // Darken at band boundaries — a thin ink line where chevron meets
  vec3 boundaryInk = vec3(0.02, 0.006, 0.004);
  bandCol = mix(boundaryInk, bandCol, edgeSoft);

  // Subtle cream → wine shading inside each band (fake dimension)
  float bandCurve = sin(bandPos * PI);
  bandCol *= 0.78 + 0.22 * bandCurve;

  // A slow orbiting warm tilt — light source circling the tunnel axis
  float orbit = cos(phi - t * 0.22) * 0.08;
  bandCol *= 1.0 + orbit;

  // Depth falloff — pinned to baseDepth so brightness is stable over time
  float depthFade = exp(-baseDepth * 0.055);
  vec3 col = bandCol * depthFade;

  // ————— paper grain —————

  vec2 gPos = gl_FragCoord.xy;
  float gFine = hash(gPos * 1.6) - 0.5;
  float gCoarse = hash(floor(gPos * 0.35)) - 0.5;
  float grain = gFine * 0.11 + gCoarse * 0.06;
  col += vec3(grain * 1.05, grain * 0.95, grain * 0.85) * depthFade;

  // Central darkness reserved for the ghost light
  float centerMask = smoothstep(0.06, 0.14, r);
  col *= centerMask;

  // Outer fade blends tunnel into the curtain shadows
  col *= smoothstep(2.2, 0.5, r);

  // Global dim — the floor is the star now, tunnel is just backdrop
  col *= 0.55;

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
