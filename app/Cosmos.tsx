"use client";

import { useEffect, useRef } from "react";
import styles from "./stage.module.css";

/**
 * A slow rotating cosmos, rendered in a fragment shader.
 *
 * Three parallax layers of stars, inner ones rotating faster — the
 * outer stars almost drift, the inner ones visibly swirl. A gentle
 * inward pull in log-radius space so the eye is drawn toward center
 * without the stars ever actually reaching it. A warm amber core,
 * pulsing like a distant heart. All colors sit inside SEEN's palette
 * so it reads as an extension of the ghost light rather than sci-fi.
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

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / min(u_resolution.x, u_resolution.y);
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float t = u_time;

  vec3 col = vec3(0.0);

  // Three depth layers.
  // Outer layers rotate slower and drift less — more distant.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);

    // Angular speed: inner layers rotate faster (Keplerian-ish feel).
    float rot = t * (0.025 + 0.05 / (0.35 + r * (0.8 + fi * 0.6)));
    rot *= (1.0 - fi * 0.18);

    // Gentle inward pull in log-radius space — the "drain".
    float logR = log(r + 0.012);
    float logShift = logR + t * 0.007 * (1.0 + fi * 0.35);

    // Polar grid for star placement.
    vec2 grid = vec2(a + rot, logShift) * vec2(9.0, 13.0);
    vec2 ig = floor(grid);
    vec2 fg = fract(grid);

    float h = hash(ig + fi * 37.0);
    if (h > 0.962) {
      vec2 cen = vec2(0.3 + fract(h * 7.3) * 0.4,
                      0.3 + fract(h * 13.7) * 0.4);
      float d = length(fg - cen);
      float b = smoothstep(0.13, 0.0, d) * (h - 0.962) * 32.0;

      // Distant layers dimmer
      b *= (1.0 - fi * 0.24);
      // Fade near very center (so stars don't pop into the core)
      b *= smoothstep(0.03, 0.14, r);
      // Fade at outer edge
      b *= smoothstep(1.85, 0.9, r);
      // Subtle twinkle
      b *= 0.68 + 0.32 * sin(t * 2.3 + h * 29.0);

      col += vec3(0.95, 0.78, 0.52) * b;
    }
  }

  // Galactic core — warm amber, pulses like a heart
  float pulse = 0.86 + 0.14 * sin(t * 0.27);
  col += vec3(0.95, 0.55, 0.22) * exp(-r * 3.1) * 0.36 * pulse;
  // Bright inner kernel
  col += vec3(1.0, 0.9, 0.7) * exp(-r * 8.5) * 0.26 * pulse;

  // Three spiral arms of faint dust, rotating slowly
  float spiralA = a + t * 0.032 + log(r + 0.012) * 1.9;
  float arm = pow(cos(spiralA * 3.0) * 0.5 + 0.5, 6.0);
  float armFade = smoothstep(1.7, 0.14, r) * smoothstep(0.02, 0.22, r);
  col += vec3(0.6, 0.28, 0.14) * arm * armFade * 0.075;

  // Faint crimson haze at the outer reaches (blends with curtain color)
  col += vec3(0.22, 0.05, 0.06)
    * smoothstep(0.35, 1.55, r)
    * smoothstep(2.4, 1.0, r) * 0.11;

  // Edge fade so the cosmos dissolves into the curtain shadows
  col *= smoothstep(2.3, 0.2, r);

  // Overall dim — stars should pop against deep black, not glare
  col *= 0.92;

  gl_FragColor = vec4(col, 1.0);
}
`;

export function Cosmos() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    // ————— compile & link —————
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

    // ————— fullscreen quad —————
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

    // ————— reduced-motion: render one frame, stop —————
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let rafId = 0;
    const t0 = performance.now();
    const frame = () => {
      const t = (performance.now() - t0) / 1000;
      gl.uniform1f(uTime, t);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!reducedMotion) rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);

    // Pause when tab is hidden — no cycles burned off-screen
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
