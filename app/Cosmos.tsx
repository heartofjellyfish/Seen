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
  float t = u_time;

  // ————— rotating galaxy —————
  //
  // Top-down view of a two-armed spiral galaxy. We rotate uv into the
  // galaxy-frame coordinate system — then stars and arms all live at
  // stable positions in that frame, and it's the viewer who appears
  // to rotate around the galactic axis. Both arms and stars rotate
  // together. Center is kept pure black so the ghost light sits
  // unopposed.

  const float PI = 3.14159265;
  const float N_ARMS = 2.0;
  const float TWIST = 2.8;

  // Visible rotation — one revolution per ~1.7 minutes, with a touch
  // more urgency as fame approaches.
  float rotSpeed = 0.06 + u_progress * u_progress * 0.03;
  float gAngle = t * rotSpeed;

  // Rotate uv into galaxy frame (stars + arms are stable there)
  float cA = cos(gAngle);
  float sA = sin(gAngle);
  vec2 gUv = vec2(uv.x * cA + uv.y * sA, -uv.x * sA + uv.y * cA);
  float gTheta = atan(gUv.y, gUv.x);

  float armPhase = N_ARMS * (gTheta + u_mouse.x * 0.14)
                 + TWIST * log(r + 0.08);

  float arm = cos(armPhase) * 0.5 + 0.5;
  arm = pow(arm, 3.5);

  float innerFade = smoothstep(0.05, 0.28, r);
  float outerFade = smoothstep(1.9, 0.45, r);
  float armMask = innerFade * outerFade;
  float armIntensity = arm * armMask;

  // ————— stars —————
  //
  // For each pixel we check a 3x3 neighbourhood of cells so star
  // rendering doesn't cut off at cell edges. Each star has a
  // gaussian pinpoint + a softer halo — gives crisp bright dots
  // with a glow, not pixelated dabs.

  float stars = 0.0;

  // Bright stars — 3x3 neighbours, gaussian pin + halo, twinkling
  vec2 bP = gUv * 55.0;
  vec2 bCell = floor(bP);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 nCell = bCell + vec2(float(dx), float(dy));
      float h = hash(nCell);
      if (h > 0.955) {
        vec2 sPos = nCell + vec2(
          0.25 + hash(nCell + vec2(17.0, 3.1)) * 0.5,
          0.25 + hash(nCell + vec2(31.0, 5.7)) * 0.5
        );
        float d2 = distance(bP, sPos);
        float pin = exp(-d2 * d2 * 95.0);
        float halo = exp(-d2 * d2 * 14.0);
        float br = (pin * 2.2 + halo * 0.55) * (h - 0.955) * 26.0;

        // Twinkle — two uncorrelated sines at different frequencies
        // give an irregular flicker instead of a metronome pulse
        float twPhase = h * 17.7 + hash(nCell + vec2(97.0, 53.0)) * 11.3;
        float tw = 0.5 + 0.5 * sin(t * 2.4 + twPhase);
        tw = mix(tw, 0.5 + 0.5 * sin(t * 4.7 + twPhase * 0.71), 0.35);
        br *= 0.35 + 0.65 * tw;

        br *= 0.28 + 0.72 * arm;
        stars += br * armMask;
      }
    }
  }

  // Fine star dust — denser, dimmer, their own twinkle at a faster rate
  vec2 fP = gUv * 160.0;
  vec2 fCell = floor(fP);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 nCell = fCell + vec2(float(dx), float(dy));
      float h = hash(nCell + vec2(7.0, 41.0));
      if (h > 0.935) {
        vec2 sPos = nCell + vec2(
          0.3 + hash(nCell + vec2(51.0, 23.0)) * 0.4,
          0.3 + hash(nCell + vec2(71.0, 19.0)) * 0.4
        );
        float d2 = distance(fP, sPos);
        float pin = exp(-d2 * d2 * 85.0);
        float br = pin * (h - 0.935) * 14.0;

        // Fine stars twinkle faster, brief sparkles
        float twPhase = h * 29.0 + hash(nCell + vec2(37.0, 19.0)) * 13.0;
        float tw = 0.5 + 0.5 * sin(t * 3.8 + twPhase);
        br *= 0.3 + 0.7 * tw;

        br *= armMask;
        stars += br * 0.5;
      }
    }
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
