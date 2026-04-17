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

  // Subtle mouse parallax — galaxy is a stately thing, don't lurch
  uv += u_mouse * 0.08;

  float r = length(uv);
  float theta = atan(uv.y, uv.x);
  float t = u_time;

  // ————— slow rotating galaxy —————
  //
  // Top-down view of a two-armed spiral galaxy. Arms follow a
  // logarithmic spiral (tighter near the core). Center is kept pure
  // black so the ghost light sits unopposed. Stars scatter across the
  // disk with a bias toward the arms; dust lanes darken the regions
  // between arms. One full revolution per ~4.5 minutes.

  const float PI = 3.14159265;
  const float N_ARMS = 2.0;
  const float TWIST = 2.8;

  float rotSpeed = 0.023 + u_progress * u_progress * 0.012;
  float phi = theta + t * rotSpeed + u_mouse.x * 0.14;

  float armPhase = N_ARMS * phi + TWIST * log(r + 0.08);

  // Sharp arm ridges
  float arm = cos(armPhase) * 0.5 + 0.5;
  arm = pow(arm, 3.5);

  // Dark hole at center (ghost light's throne), arms in a ring
  float innerFade = smoothstep(0.05, 0.28, r);
  float outerFade = smoothstep(1.9, 0.45, r);
  float armMask = innerFade * outerFade;
  float armIntensity = arm * armMask;

  // ————— stars —————

  // Bright sparse stars, preferentially on arms
  vec2 sCell = floor(uv * 70.0);
  float sHash = hash(sCell);
  float stars = 0.0;
  if (sHash > 0.97) {
    vec2 sFrac = fract(uv * 70.0);
    vec2 sPos = vec2(
      0.35 + hash(sCell + vec2(11.0, 3.0)) * 0.3,
      0.35 + hash(sCell + vec2(23.0, 7.0)) * 0.3
    );
    float sd = distance(sFrac, sPos);
    float s = smoothstep(0.14, 0.0, sd) * (sHash - 0.97) * 42.0;
    s *= 0.3 + 0.7 * arm;
    s *= armMask * 1.3;
    stars += s;
  }

  // Fine star dust — everywhere in the disk
  vec2 dCell = floor(uv * 180.0);
  float dHash = hash(dCell + vec2(7.0, 41.0));
  if (dHash > 0.958) {
    float s = (dHash - 0.958) * 12.0;
    s *= armMask;
    stars += s * 0.45;
  }

  // ————— dust lanes between arms —————

  float dustPhase = armPhase + PI * 0.45;
  float dust = pow(cos(dustPhase) * 0.5 + 0.5, 3.5);
  float dustDarken = dust * armMask * 0.35;

  // ————— palette + composite —————

  vec3 space = vec3(0.014, 0.013, 0.022);
  vec3 armAmber = vec3(0.56, 0.36, 0.17);
  vec3 armWarm = vec3(0.88, 0.60, 0.28);
  vec3 starColor = vec3(1.0, 0.94, 0.78);

  vec3 col = space;
  col += mix(armAmber, armWarm, arm) * armIntensity * 0.8;
  col += starColor * stars;
  col -= vec3(0.012, 0.012, 0.02) * dustDarken;
  col = max(col, vec3(0.0));

  // Subtle screen-space grain — film emulsion suggestion
  float grain = (hash(gl_FragCoord.xy * 1.3) - 0.5) * 0.028;
  col += vec3(grain * 0.9, grain, grain * 1.1);

  // Central darkness reserved for the ghost light
  float centerMask = smoothstep(0.04, 0.07, r);
  col *= centerMask;

  // Outer fade blends galaxy into the curtain shadows
  col *= smoothstep(2.1, 0.4, r);

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
