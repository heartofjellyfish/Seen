"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./stage.module.css";
import { Cosmos } from "./Cosmos";

/**
 * A full-viewport theater before the show.
 *
 * Left/right CSS-velvet curtains flank the entire viewport height.
 * A scalloped pelmet runs across the top.
 * In the gap between the curtains: red carpet, ghost light,
 * stanchions + velvet rope (the countdown device).
 */
export function Stage({
  progress = 0,
  epigraph = "有一个座位，留着。",
  epigraphEn = "A seat is kept.",
  children,
}: {
  progress?: number;
  epigraph?: string;
  epigraphEn?: string;
  children?: React.ReactNode;
}) {
  const p = Math.max(0, Math.min(1, progress));
  const eased = p * p * p;

  // Rope geometry in stage-scene SVG viewBox coords (700 x 900)
  const LX = 190;
  const RX = 510;
  const TOP_Y = 470;
  const CX = (LX + RX) / 2;
  const maxSag = 72;
  const ctrlY = TOP_Y + eased * maxSag;

  const fallStart = 0.88;
  const fall =
    p < fallStart ? 0 : Math.min(1, (p - fallStart) / (1 - fallStart));
  const rightAnchorY = TOP_Y + fall * 76;
  const ropeOpacity = p > 0.985 ? 0 : 1 - fall * 0.15;

  const glow = 0.55 + eased * 0.35;

  // Mouse-parallax: drive --mx/--my CSS custom props on the hall element
  // so the stageScene (and anything else using them) drifts with the cursor.
  const hallRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = hallRef.current;
    if (!el) return;
    const target = { x: 0, y: 0 };
    const smooth = { x: 0, y: 0 };
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      target.x = (e.clientX / w) * 2 - 1;
      target.y = (e.clientY / h) * 2 - 1;
    };
    const onLeave = () => {
      target.x = 0;
      target.y = 0;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    let rafId = 0;
    const tick = () => {
      smooth.x += (target.x - smooth.x) * 0.06;
      smooth.y += (target.y - smooth.y) * 0.06;
      el.style.setProperty("--mx", smooth.x.toFixed(3));
      el.style.setProperty("--my", smooth.y.toFixed(3));
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div className={styles.hall} ref={hallRef}>
      {/* ————— decorative layer ————— */}
      <div className={styles.bg}>
        {/* Rotating corridor behind the stage opening */}
        <Cosmos progress={p} />

        {/* Side curtains (CSS velvet) */}
        <div className={`${styles.curtain} ${styles.curtainL}`} />
        <div className={`${styles.curtain} ${styles.curtainR}`} />

        {/* Scalloped pelmet */}
        <svg
          className={styles.pelmet}
          viewBox="0 0 1200 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <defs>
            <linearGradient id="pelmetGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2e0b10" />
              <stop offset="45%" stopColor="#4a1419" />
              <stop offset="100%" stopColor="#280a0f" />
            </linearGradient>
            <pattern
              id="pelmetPleats"
              patternUnits="userSpaceOnUse"
              width="30"
              height="100"
            >
              <rect width="30" height="100" fill="url(#pelmetGrad)" />
              <rect x="0" width="1" height="100" fill="#150405" opacity="0.85" />
              <rect x="14" width="2" height="100" fill="#5f1f29" opacity="0.55" />
            </pattern>
          </defs>
          <path
            d="M 0 0 L 1200 0 L 1200 72
               Q 1180 100 1160 72 Q 1140 100 1120 72 Q 1100 100 1080 72 Q 1060 100 1040 72
               Q 1020 100 1000 72 Q 980 100 960 72 Q 940 100 920 72 Q 900 100 880 72
               Q 860 100 840 72 Q 820 100 800 72 Q 780 100 760 72 Q 740 100 720 72
               Q 700 100 680 72 Q 660 100 640 72 Q 620 100 600 72 Q 580 100 560 72
               Q 540 100 520 72 Q 500 100 480 72 Q 460 100 440 72 Q 420 100 400 72
               Q 380 100 360 72 Q 340 100 320 72 Q 300 100 280 72 Q 260 100 240 72
               Q 220 100 200 72 Q 180 100 160 72 Q 140 100 120 72 Q 100 100 80 72
               Q 60 100 40 72 Q 20 100 0 72 Z"
            fill="url(#pelmetPleats)"
          />
        </svg>

        {/* Central stage scene */}
        <svg
          className={styles.stageScene}
          viewBox="0 0 700 900"
          preserveAspectRatio="xMidYMax meet"
          aria-hidden
        >
          <defs>
            <radialGradient id="pool" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#d4a363" stopOpacity="0.55" />
              <stop offset="45%" stopColor="#b9853f" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#6b3a14" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="bulb" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffe8b9" stopOpacity="1" />
              <stop offset="35%" stopColor="#f0c47c" stopOpacity="0.95" />
              <stop offset="70%" stopColor="#c88c3a" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#6b3a14" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="halo" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#d4a363" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#d4a363" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="carpet" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#2f0b10" />
              <stop offset="55%" stopColor="#551820" />
              <stop offset="100%" stopColor="#6b1f27" />
            </linearGradient>
            <linearGradient id="rope" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#6b1f27" />
              <stop offset="50%" stopColor="#8f2a34" />
              <stop offset="100%" stopColor="#4a1419" />
            </linearGradient>

          </defs>

          {/* Large soft halo behind ghost light */}
          <circle
            cx="350"
            cy="400"
            r="260"
            fill="url(#halo)"
            style={{ opacity: 0.5 + eased * 0.3 }}
          />

          {/* Red carpet — narrow at stage, wide toward viewer */}
          <path
            d="M 270 500 L 430 500 L 680 900 L 20 900 Z"
            fill="url(#carpet)"
          />
          <path
            d="M 270 500 L 20 900"
            stroke="rgba(232,192,137,0.08)"
            strokeWidth="1.2"
            fill="none"
          />
          <path
            d="M 430 500 L 680 900"
            stroke="rgba(232,192,137,0.08)"
            strokeWidth="1.2"
            fill="none"
          />

          {/* Stage floor edge hairline */}
          <line
            x1="0"
            y1="500"
            x2="700"
            y2="500"
            stroke="rgba(212,163,99,0.22)"
            strokeWidth="0.6"
          />

          {/* Ghost light pool on carpet */}
          <ellipse
            cx="350"
            cy="512"
            rx="160"
            ry="30"
            fill="url(#pool)"
            style={{ opacity: glow }}
          />

          {/* Ghost light: brass pole + cage + bulb */}
          <g className={styles.ghost}>
            <ellipse cx="350" cy="494" rx="14" ry="3" fill="#1a1108" />
            <rect x="342" y="478" width="16" height="16" fill="#6a4e25" />
            <rect x="347" y="340" width="6" height="140" fill="#8b6a34" />
            <rect x="347" y="340" width="1.8" height="140" fill="#d4a363" opacity="0.45" />
            <rect x="337" y="286" width="1" height="62" fill="#7a5a2a" />
            <rect x="362" y="286" width="1" height="62" fill="#7a5a2a" />
            <ellipse cx="350" cy="286" rx="13" ry="2.2" fill="none" stroke="#7a5a2a" strokeWidth="0.9" />
            <ellipse cx="350" cy="348" rx="13" ry="2.2" fill="none" stroke="#7a5a2a" strokeWidth="0.9" />
            <circle
              cx="350"
              cy="316"
              r="52"
              fill="url(#bulb)"
              style={{ opacity: 0.6 + eased * 0.3 }}
            />
            <circle cx="350" cy="316" r="10" fill="#fff1c7" />
            <circle cx="350" cy="316" r="5" fill="#fffbe8" />
          </g>

          {/* Dust motes in the beam */}
          <g className={styles.motes}>
            {MOTE_POSITIONS.map((m, i) => (
              <circle
                key={i}
                cx={m.x}
                cy={m.y}
                r={m.r}
                fill="#e8c089"
                className={styles.mote}
                style={{
                  animationDelay: `${m.delay}s`,
                  animationDuration: `${m.dur}s`,
                }}
              />
            ))}
          </g>

          {/* Stanchions + velvet rope (countdown device) */}
          <g className={styles.stanchions}>
            <rect x={LX - 2.5} y={TOP_Y} width="5" height="150" fill="#7a5a2a" />
            <rect x={LX - 2.5} y={TOP_Y} width="1.6" height="150" fill="#d4a363" opacity="0.5" />
            <ellipse cx={LX} cy={TOP_Y - 7} rx="10" ry="10" fill="#b8892e" />
            <ellipse cx={LX} cy={TOP_Y - 7} rx="5.5" ry="5.5" fill="#e8c089" />
            <ellipse cx={LX} cy={TOP_Y + 150} rx="20" ry="5" fill="#1a1108" />

            <rect x={RX - 2.5} y={TOP_Y} width="5" height="150" fill="#7a5a2a" />
            <rect x={RX - 2.5} y={TOP_Y} width="1.6" height="150" fill="#d4a363" opacity="0.5" />
            <ellipse cx={RX} cy={TOP_Y - 7} rx="10" ry="10" fill="#b8892e" />
            <ellipse cx={RX} cy={TOP_Y - 7} rx="5.5" ry="5.5" fill="#e8c089" />
            <ellipse cx={RX} cy={TOP_Y + 150} rx="20" ry="5" fill="#1a1108" />

            <path
              d={`M ${LX} ${TOP_Y - 7} Q ${CX} ${ctrlY} ${RX} ${rightAnchorY - 7}`}
              stroke="url(#rope)"
              strokeWidth="6"
              strokeLinecap="round"
              fill="none"
              style={{ opacity: ropeOpacity, transition: "opacity 2s ease" }}
            />
            <path
              d={`M ${LX} ${TOP_Y - 7} Q ${CX} ${ctrlY} ${RX} ${rightAnchorY - 7}`}
              stroke="#c9414d"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeDasharray="2 5"
              fill="none"
              style={{ opacity: ropeOpacity * 0.5, transition: "opacity 2s ease" }}
            />
          </g>

        </svg>

        {/* Dream objects — HTML layer for real CSS 3D transforms */}
        <DreamObjects />

        {/* Vignette on top of everything */}
        <div className={styles.vignette} />
      </div>

      {/* ————— text + actions ————— */}
      <div className={styles.top}>
        <p className={styles.epigraph}>{epigraph}</p>
        <p className={styles.epigraphEn}>{epigraphEn}</p>
      </div>
      <div className={styles.spacer} />
      <div className={styles.bottom}>
        <Musing />
        {children ? <div className={styles.actions}>{children}</div> : null}
      </div>
    </div>
  );
}

// ————— dream objects —————
//
// HTML layer overlaid on the stage opening. Each item is a div with
// real CSS 3D transforms (perspective-enabled parent, rotateY/X/Z
// tumble) — no scaleY fakery, so when an object flips 90 degrees
// you actually see the edge. Six items with coprime durations so
// their spawn pattern never visibly repeats.

type DreamKind = "pill" | "coin" | "key" | "note" | "ring" | "feather";

const DREAM_ITEMS: Array<{
  kind: DreamKind;
  pathClass: string;
  tumbleClass: string;
}> = [
  { kind: "pill",    pathClass: "path1", tumbleClass: "tumbleY" },
  { kind: "coin",    pathClass: "path2", tumbleClass: "tumbleX" },
  { kind: "key",     pathClass: "path3", tumbleClass: "tumbleSpin" },
  { kind: "note",    pathClass: "path4", tumbleClass: "tumbleY" },
  { kind: "ring",    pathClass: "path5", tumbleClass: "tumbleBoth" },
  { kind: "feather", pathClass: "path6", tumbleClass: "tumbleSpin" },
];

function DreamObjects() {
  return (
    <div className={styles.dreamLayer} aria-hidden>
      {/* Shared gradient defs — referenced by each dream object's SVG */}
      <svg className={styles.dreamDefs}>
        <defs>
          <linearGradient id="dr-pill-body" x1="0.3" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stopColor="#fff6e2" />
            <stop offset="30%" stopColor="#f0d8a6" />
            <stop offset="55%" stopColor="#c89848" />
            <stop offset="85%" stopColor="#6a4518" />
            <stop offset="100%" stopColor="#2a1a08" />
          </linearGradient>
          <linearGradient id="dr-pill-amber" x1="0.3" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stopColor="#f8ca7a" />
            <stop offset="40%" stopColor="#c88a3a" />
            <stop offset="80%" stopColor="#6a4518" />
            <stop offset="100%" stopColor="#20100a" />
          </linearGradient>
          <radialGradient id="dr-coin-face" cx="30%" cy="20%" r="90%">
            <stop offset="0%" stopColor="#fff6d8" />
            <stop offset="25%" stopColor="#ecc580" />
            <stop offset="55%" stopColor="#b8863a" />
            <stop offset="85%" stopColor="#5a3e18" />
            <stop offset="100%" stopColor="#2a1a08" />
          </radialGradient>
          <linearGradient id="dr-brass" x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0%" stopColor="#fff4c8" />
            <stop offset="25%" stopColor="#ecc580" />
            <stop offset="50%" stopColor="#b8862e" />
            <stop offset="80%" stopColor="#6a4818" />
            <stop offset="100%" stopColor="#30200a" />
          </linearGradient>
          <linearGradient id="dr-paper" x1="0" y1="0" x2="0.2" y2="1">
            <stop offset="0%" stopColor="#fff5db" />
            <stop offset="50%" stopColor="#ddc898" />
            <stop offset="100%" stopColor="#8a6e3c" />
          </linearGradient>
        </defs>
      </svg>

      {DREAM_ITEMS.map((item, i) => (
        <div key={i} className={`${styles.dream} ${styles[item.pathClass]}`}>
          <div className={`${styles.tumble} ${styles[item.tumbleClass]}`}>
            <DreamObject kind={item.kind} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DreamObject({ kind }: { kind: DreamKind }) {
  if (kind === "pill") {
    return (
      <svg
        width="82"
        height="40"
        viewBox="-41 -20 82 40"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block", overflow: "visible" }}
      >
        <rect x="-20" y="-9" width="20" height="18" fill="url(#dr-pill-body)" rx="0.6" />
        <ellipse cx="-20" cy="0" rx="9" ry="9" fill="url(#dr-pill-body)" />
        <rect x="0" y="-9" width="20" height="18" fill="url(#dr-pill-amber)" rx="0.6" />
        <ellipse cx="20" cy="0" rx="9" ry="9" fill="url(#dr-pill-amber)" />
        <line x1="0" y1="-8.5" x2="0" y2="8.5" stroke="#3a2810" strokeWidth="0.6" />
        <rect x="-14" y="-7" width="28" height="1.6" fill="#fff" opacity="0.9" rx="0.8" />
        <ellipse cx="-4" cy="-4" rx="18" ry="1.6" fill="#fff" opacity="0.35" />
      </svg>
    );
  }
  if (kind === "coin") {
    return (
      <svg
        width="34"
        height="34"
        viewBox="-17 -17 34 34"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block", overflow: "visible" }}
      >
        <circle cx="0" cy="1" r="14" fill="#1a1008" />
        <circle cx="0" cy="0" r="13" fill="url(#dr-coin-face)" />
        <circle cx="0" cy="0" r="13" fill="none" stroke="#3a2810" strokeWidth="0.7" />
        <circle cx="0" cy="0" r="11" fill="none" stroke="#7a5018" strokeWidth="0.45" opacity="0.7" />
        <text
          x="0"
          y="5"
          fontSize="14"
          textAnchor="middle"
          fill="#3a2810"
          fontFamily="serif"
          fontStyle="italic"
          opacity="0.78"
        >
          s
        </text>
        <ellipse cx="-4" cy="-5" rx="6" ry="3" fill="#fff" opacity="0.6" />
        <ellipse cx="-6.5" cy="-7.5" rx="2.5" ry="1.2" fill="#fff" opacity="0.55" />
      </svg>
    );
  }
  if (kind === "key") {
    return (
      <svg
        width="44"
        height="22"
        viewBox="-24 -11 44 22"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block", overflow: "visible" }}
      >
        <circle cx="-14" cy="0" r="8" fill="none" stroke="url(#dr-brass)" strokeWidth="3.2" />
        <circle cx="-14" cy="0" r="2.8" fill="#0a0805" />
        <rect x="-6.5" y="-2.2" width="19" height="4.4" fill="url(#dr-brass)" rx="0.8" />
        <rect x="4" y="2.2" width="3" height="3.8" fill="url(#dr-brass)" />
        <rect x="8.5" y="2.2" width="2.5" height="5" fill="url(#dr-brass)" />
        <rect x="-6.5" y="-2.2" width="19" height="1.3" fill="#fff" opacity="0.75" rx="0.8" />
        <path
          d="M -20 -3 A 8 8 0 0 1 -12 -7"
          fill="none"
          stroke="#fff"
          strokeWidth="0.8"
          opacity="0.7"
        />
      </svg>
    );
  }
  if (kind === "ring") {
    return (
      <svg
        width="36"
        height="32"
        viewBox="-18 -16 36 32"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block", overflow: "visible" }}
      >
        {/* Outer brass band */}
        <ellipse cx="0" cy="0" rx="15" ry="13" fill="url(#dr-brass)" />
        {/* Inner hole (darker, suggests depth through the ring) */}
        <ellipse cx="0" cy="0.5" rx="10" ry="8" fill="#0a0604" />
        {/* Inner rim — a thin darker line around the hole */}
        <ellipse
          cx="0"
          cy="0.5"
          rx="10"
          ry="8"
          fill="none"
          stroke="#3a2810"
          strokeWidth="0.5"
        />
        {/* Top arc specular — the glint across the band */}
        <path
          d="M -10 -9 A 15 13 0 0 1 8 -11"
          fill="none"
          stroke="#fff"
          strokeWidth="1.1"
          opacity="0.8"
        />
        {/* Inner highlight on the hole's upper edge */}
        <path
          d="M -6 -6 A 10 8 0 0 1 4 -7"
          fill="none"
          stroke="#fff"
          strokeWidth="0.4"
          opacity="0.4"
        />
        {/* Tiny set stone */}
        <circle cx="0" cy="-10.5" r="2.2" fill="#fff5c6" />
        <circle cx="0" cy="-10.5" r="2.2" fill="none" stroke="#3a2810" strokeWidth="0.3" />
        <circle cx="-0.6" cy="-11" r="0.7" fill="#fff" opacity="0.9" />
      </svg>
    );
  }
  if (kind === "feather") {
    return (
      <svg
        width="18"
        height="46"
        viewBox="-9 -23 18 46"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block", overflow: "visible" }}
      >
        {/* Vane silhouette — a pointed leaf shape */}
        <path
          d="M 0 -22 C -6 -15, -7 -2, -5 14 C -3 20, 3 20, 5 14 C 7 -2, 6 -15, 0 -22 Z"
          fill="url(#dr-paper)"
          opacity="0.88"
        />
        {/* Quill (central spine) */}
        <line
          x1="0"
          y1="22"
          x2="0"
          y2="-22"
          stroke="#3a2810"
          strokeWidth="0.55"
        />
        {/* Barbs on the left side */}
        <line x1="0" y1="-18" x2="-4" y2="-13" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="-13" x2="-5.2" y2="-7" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="-7" x2="-5.5" y2="-0.5" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="-1" x2="-5.5" y2="6" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="5" x2="-4.8" y2="12" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="11" x2="-3.5" y2="17" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        {/* Barbs on the right side */}
        <line x1="0" y1="-18" x2="4" y2="-13" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="-13" x2="5.2" y2="-7" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="-7" x2="5.5" y2="-0.5" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="-1" x2="5.5" y2="6" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="5" x2="4.8" y2="12" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
        <line x1="0" y1="11" x2="3.5" y2="17" stroke="#6a4818" strokeWidth="0.3" opacity="0.7" />
      </svg>
    );
  }
  // note
  return (
    <svg
      width="24"
      height="32"
      viewBox="-12 -16 24 32"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block", overflow: "visible" }}
    >
      <path
        d="M -10 -14 L 10 -14 L 10 14 L -7 14 L -10 11 Z"
        fill="url(#dr-paper)"
      />
      <path d="M -10 11 L -7 14 L -7 11 Z" fill="#8a6e3c" opacity="0.85" />
      <line x1="-6" y1="-9" x2="7" y2="-9" stroke="#3a2a10" strokeWidth="0.5" opacity="0.82" />
      <line x1="-6" y1="-6" x2="5" y2="-6" stroke="#3a2a10" strokeWidth="0.5" opacity="0.82" />
      <line x1="-6" y1="-3" x2="7" y2="-3" stroke="#3a2a10" strokeWidth="0.5" opacity="0.82" />
      <line x1="-6" y1="1" x2="6" y2="1" stroke="#3a2a10" strokeWidth="0.5" opacity="0.82" />
      <line x1="-6" y1="4" x2="7" y2="4" stroke="#3a2a10" strokeWidth="0.5" opacity="0.82" />
      <line x1="-6" y1="7" x2="3" y2="7" stroke="#3a2a10" strokeWidth="0.5" opacity="0.82" />
      <rect x="-10" y="-14" width="20" height="3.2" fill="#fff" opacity="0.4" rx="0.5" />
    </svg>
  );
}

// ————— rotating philosophical line —————

const MUSINGS: Array<{ zh: string; en: string }> = [
  {
    zh: "成名是什么——不过一屋子陌生人，短暂地一起看。",
    en: "What is fame — but a room of strangers, briefly agreeing to look.",
  },
  {
    zh: "十五分钟。够，说一件真的事。",
    en: "Fifteen minutes. Long enough for one true thing.",
  },
  {
    zh: "有一个人，正在幕后。我们还不知道是谁。",
    en: "Someone is backstage. We do not yet know who.",
  },
  {
    zh: "灯亮之前，是静。",
    en: "Before the lights, the hush.",
  },
  {
    zh: "这里的舞台不记得谁上过。也算一种温柔。",
    en: "This stage remembers no one. Which is also a kindness.",
  },
];

const MUSING_INTERVAL_MS = 3 * 60 * 1000;

function Musing() {
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIdx((i) => (i + 1) % MUSINGS.length);
        setVisible(true);
      }, 2400);
    }, MUSING_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const m = MUSINGS[idx];
  return (
    <div
      className={styles.musing}
      style={{ opacity: visible ? 1 : 0 }}
      aria-live="polite"
    >
      <p className={styles.musingZh}>{m.zh}</p>
      <p className={styles.musingEn}>{m.en}</p>
    </div>
  );
}

// ————— dust mote positions (in stage-scene viewBox) —————

const MOTE_POSITIONS: Array<{
  x: number;
  y: number;
  r: number;
  delay: number;
  dur: number;
}> = [
  { x: 306, y: 500, r: 1.4, delay: 0, dur: 10 },
  { x: 324, y: 514, r: 1.0, delay: 2.6, dur: 12 },
  { x: 346, y: 494, r: 1.6, delay: 5.0, dur: 11 },
  { x: 366, y: 510, r: 1.0, delay: 1.2, dur: 13 },
  { x: 384, y: 498, r: 1.3, delay: 6.4, dur: 10 },
  { x: 402, y: 512, r: 1.1, delay: 3.6, dur: 12 },
  { x: 336, y: 520, r: 0.9, delay: 7.8, dur: 10 },
  { x: 374, y: 520, r: 0.9, delay: 5.2, dur: 14 },
];
