"use client";

import { useEffect, useState } from "react";
import styles from "./stage.module.css";

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

  return (
    <div className={styles.hall}>
      {/* ————— decorative layer ————— */}
      <div className={styles.bg}>
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
