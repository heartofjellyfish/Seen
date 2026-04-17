"use client";

import { useEffect, useState } from "react";
import styles from "./stage.module.css";

/**
 * The waiting room is a theater before the show.
 *
 * - Proscenium + velvet curtain, drawn.
 * - A red carpet runs from the curtain to the viewer.
 * - A lone ghost light burns center-stage.
 * - A velvet rope between two brass stanchions is the countdown:
 *     it sags, then falls, as the moment approaches. No numbers.
 *
 * `progress` is 0..1 through the current cycle (or quiet window).
 * We map it through a cubic so the rope stays "up" for most of the
 * wait and only visibly droops near the end — the theatrical hush.
 */
export function Stage({
  progress = 0,
  epigraph = "有一个座位，留着。",
  epigraphEn = "A seat is kept.",
}: {
  progress?: number;
  epigraph?: string;
  epigraphEn?: string;
}) {
  const p = Math.max(0, Math.min(1, progress));
  const eased = p * p * p; // cubic — nothing for a long time, then a lot

  // Rope geometry
  const LX = 155; // left stanchion x
  const RX = 445; // right stanchion x
  const TOP_Y = 378; // anchor y on both stanchions
  const CX = (LX + RX) / 2;
  const maxSag = 56;
  const sag = eased * maxSag;
  const ctrlY = TOP_Y + sag;

  // Near the very end the right side falls off the stanchion
  const fallStart = 0.88;
  const fall =
    p < fallStart ? 0 : Math.min(1, (p - fallStart) / (1 - fallStart));
  const rightAnchorY = TOP_Y + fall * 62; // drops to carpet
  const ropeOpacity = p > 0.985 ? 0 : 1 - fall * 0.15;

  // Ghost light pool intensity grows slowly
  const glow = 0.55 + eased * 0.35;

  return (
    <div className={styles.hall}>
      {/* Top epigraph — permanent, quiet */}
      <div className={styles.epigraphWrap} aria-hidden={false}>
        <p className={styles.epigraph}>{epigraph}</p>
        <p className={styles.epigraphEn}>{epigraphEn}</p>
      </div>

      <svg
        className={styles.theater}
        viewBox="0 0 600 520"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="An empty stage before the show."
      >
        <defs>
          {/* Velvet curtain — vertical pleats as alternating stripes */}
          <pattern
            id="velvet"
            patternUnits="userSpaceOnUse"
            width="22"
            height="100"
          >
            <rect width="22" height="100" fill="#4d1319" />
            <rect x="0" width="1" height="100" fill="#2a0a0e" />
            <rect x="6" width="3" height="100" fill="#68202a" opacity="0.9" />
            <rect x="14" width="1.5" height="100" fill="#2e0b10" />
            <rect x="19" width="2" height="100" fill="#5a1a23" />
          </pattern>

          {/* Pelmet velvet — slightly darker, horizontal hint */}
          <linearGradient id="pelmet" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2e0b10" />
            <stop offset="40%" stopColor="#4a1419" />
            <stop offset="100%" stopColor="#280a0f" />
          </linearGradient>

          {/* Red carpet — deeper at far end, slight sheen toward viewer */}
          <linearGradient id="carpet" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2f0b10" />
            <stop offset="55%" stopColor="#551820" />
            <stop offset="100%" stopColor="#6b1f27" />
          </linearGradient>

          {/* Stage floor — warm dark wood */}
          <linearGradient id="floor" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#1c140b" />
            <stop offset="100%" stopColor="#100a06" />
          </linearGradient>

          {/* Ghost light — the pool on the carpet */}
          <radialGradient id="pool" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#d4a363" stopOpacity="0.55" />
            <stop offset="45%" stopColor="#b9853f" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#6b3a14" stopOpacity="0" />
          </radialGradient>

          {/* Ghost light — the bulb itself */}
          <radialGradient id="bulb" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffe8b9" stopOpacity="1" />
            <stop offset="35%" stopColor="#f0c47c" stopOpacity="0.95" />
            <stop offset="70%" stopColor="#c88c3a" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#6b3a14" stopOpacity="0" />
          </radialGradient>

          {/* Hall vignette */}
          <radialGradient id="vignette" cx="50%" cy="40%" r="70%">
            <stop offset="0%" stopColor="#0e0b07" stopOpacity="0" />
            <stop offset="75%" stopColor="#0e0b07" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#0e0b07" stopOpacity="0.95" />
          </radialGradient>

          {/* Rope — velvet braid suggestion */}
          <linearGradient id="rope" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#6b1f27" />
            <stop offset="50%" stopColor="#8f2a34" />
            <stop offset="100%" stopColor="#4a1419" />
          </linearGradient>
        </defs>

        {/* Hall / far darkness */}
        <rect width="600" height="520" fill="#0e0b07" />

        {/* Faint amber proscenium arch — hairlines only */}
        <path
          d="M 60 110 Q 300 78 540 110 L 540 355 L 60 355 Z"
          fill="none"
          stroke="rgba(212,163,99,0.14)"
          strokeWidth="0.6"
        />
        <path
          d="M 60 110 Q 300 78 540 110"
          fill="none"
          stroke="rgba(212,163,99,0.22)"
          strokeWidth="0.8"
        />

        {/* Pelmet (top valance) */}
        <path
          d="M 60 110 Q 300 78 540 110 L 540 170
             Q 510 182 480 170 Q 450 182 420 170
             Q 390 182 360 170 Q 330 182 300 170
             Q 270 182 240 170 Q 210 182 180 170
             Q 150 182 120 170 Q 90 182 60 170 Z"
          fill="url(#pelmet)"
        />

        {/* Main curtain — two halves meeting at center with a fine seam */}
        <g className={styles.curtain}>
          {/* Left half */}
          <rect x="60" y="170" width="240" height="190" fill="url(#velvet)" />
          {/* Right half */}
          <rect x="300" y="170" width="240" height="190" fill="url(#velvet)" />
          {/* Inner edge shadow (both halves) */}
          <rect
            x="288"
            y="170"
            width="12"
            height="190"
            fill="#1a0608"
            opacity="0.85"
          />
          <rect
            x="300"
            y="170"
            width="12"
            height="190"
            fill="#1a0608"
            opacity="0.85"
          />
          {/* Faint center seam */}
          <line
            x1="300"
            y1="170"
            x2="300"
            y2="360"
            stroke="#050203"
            strokeWidth="0.6"
          />
          {/* Scalloped pelmet bottom detail — already in pelmet path */}
        </g>

        {/* Stage floor strip at curtain's foot */}
        <rect x="60" y="355" width="480" height="18" fill="url(#floor)" />
        <line
          x1="60"
          y1="355"
          x2="540"
          y2="355"
          stroke="rgba(212,163,99,0.18)"
          strokeWidth="0.5"
        />

        {/* Red carpet — tapered trapezoid in perspective */}
        <path
          d="M 250 373 L 350 373 L 470 512 L 130 512 Z"
          fill="url(#carpet)"
        />
        {/* Subtle carpet edge highlights */}
        <path
          d="M 250 373 L 130 512"
          stroke="rgba(232,192,137,0.08)"
          strokeWidth="1"
          fill="none"
        />
        <path
          d="M 350 373 L 470 512"
          stroke="rgba(232,192,137,0.08)"
          strokeWidth="1"
          fill="none"
        />

        {/* Ghost light pool on the carpet at stage foot */}
        <ellipse
          cx="300"
          cy="382"
          rx="110"
          ry="22"
          fill="url(#pool)"
          style={{ opacity: glow }}
        />

        {/* Ghost light — brass pole + bulb in front of curtain seam */}
        <g className={styles.ghost}>
          {/* Base */}
          <ellipse cx="300" cy="370" rx="10" ry="2.2" fill="#1a1108" />
          <rect x="295" y="361" width="10" height="9" fill="#6a4e25" />
          {/* Pole */}
          <rect x="298.5" y="278" width="3" height="84" fill="#8b6a34" />
          <rect x="298.5" y="278" width="1" height="84" fill="#d4a363" opacity="0.45" />
          {/* Cage (2 thin vertical ribs + rings) */}
          <rect x="292" y="244" width="0.8" height="40" fill="#7a5a2a" />
          <rect x="307" y="244" width="0.8" height="40" fill="#7a5a2a" />
          <ellipse cx="299.5" cy="244" rx="8" ry="1.2" fill="none" stroke="#7a5a2a" strokeWidth="0.7" />
          <ellipse cx="299.5" cy="284" rx="8" ry="1.2" fill="none" stroke="#7a5a2a" strokeWidth="0.7" />
          {/* Halo */}
          <circle cx="299.5" cy="264" r="34" fill="url(#bulb)" style={{ opacity: 0.55 + eased * 0.3 }} />
          {/* Bulb proper */}
          <circle cx="299.5" cy="264" r="6.5" fill="#fff1c7" />
          <circle cx="299.5" cy="264" r="3.2" fill="#fffbe8" />
        </g>

        {/* Dust motes floating in the light */}
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

        {/* Stanchions + rope — the countdown device */}
        <g className={styles.stanchions}>
          {/* Left stanchion */}
          <rect x={LX - 1.5} y={TOP_Y} width="3" height="98" fill="#7a5a2a" />
          <rect x={LX - 1.5} y={TOP_Y} width="1" height="98" fill="#d4a363" opacity="0.5" />
          <ellipse cx={LX} cy={TOP_Y - 4} rx="6" ry="6" fill="#b8892e" />
          <ellipse cx={LX} cy={TOP_Y - 4} rx="3.5" ry="3.5" fill="#e8c089" />
          <ellipse cx={LX} cy={TOP_Y + 98} rx="12" ry="3" fill="#1a1108" />

          {/* Right stanchion */}
          <rect x={RX - 1.5} y={TOP_Y} width="3" height="98" fill="#7a5a2a" />
          <rect x={RX - 1.5} y={TOP_Y} width="1" height="98" fill="#d4a363" opacity="0.5" />
          <ellipse cx={RX} cy={TOP_Y - 4} rx="6" ry="6" fill="#b8892e" />
          <ellipse cx={RX} cy={TOP_Y - 4} rx="3.5" ry="3.5" fill="#e8c089" />
          <ellipse cx={RX} cy={TOP_Y + 98} rx="12" ry="3" fill="#1a1108" />

          {/* The rope — a quadratic bezier that sags */}
          <path
            d={`M ${LX} ${TOP_Y - 4} Q ${CX} ${ctrlY} ${RX} ${rightAnchorY - 4}`}
            stroke="url(#rope)"
            strokeWidth="3.5"
            strokeLinecap="round"
            fill="none"
            style={{ opacity: ropeOpacity, transition: "opacity 2s ease" }}
          />
          {/* Tiny twist highlight */}
          <path
            d={`M ${LX} ${TOP_Y - 4} Q ${CX} ${ctrlY} ${RX} ${rightAnchorY - 4}`}
            stroke="#c9414d"
            strokeWidth="0.8"
            strokeLinecap="round"
            strokeDasharray="1.5 3"
            fill="none"
            style={{ opacity: ropeOpacity * 0.5, transition: "opacity 2s ease" }}
          />
        </g>

        {/* Hall vignette on top of everything except epigraph */}
        <rect
          width="600"
          height="520"
          fill="url(#vignette)"
          pointerEvents="none"
        />
      </svg>

      {/* Philosophical line — rotating, slow */}
      <Musing />
    </div>
  );
}

// ————— the rotating line under the stage —————

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

const MUSING_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes per line

function Musing() {
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // rotate slowly; fade out, swap, fade in
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

// ————— dust mote positions (fixed, so they don't re-shuffle on re-render) —————

const MOTE_POSITIONS: Array<{ x: number; y: number; r: number; delay: number; dur: number }> = [
  { x: 262, y: 382, r: 1.1, delay: 0, dur: 9 },
  { x: 278, y: 388, r: 0.9, delay: 2.4, dur: 11 },
  { x: 292, y: 376, r: 1.3, delay: 4.8, dur: 10 },
  { x: 306, y: 390, r: 0.8, delay: 1.1, dur: 12 },
  { x: 318, y: 378, r: 1.2, delay: 6.2, dur: 10 },
  { x: 334, y: 386, r: 0.9, delay: 3.5, dur: 11 },
  { x: 348, y: 380, r: 1.0, delay: 7.8, dur: 9 },
  { x: 286, y: 394, r: 0.7, delay: 5.0, dur: 13 },
];
