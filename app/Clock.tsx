"use client";

import styles from "./page.module.css";

/**
 * A waiting-clock. Twelve tick marks, a single amber hand sweeping clockwise
 * from 12 o'clock, and a filled amber arc painting in behind it. When the
 * hand completes a full turn, the next fame window begins.
 *
 * `progress` is [0, 1], bucketed to 1% by the server. Intentionally static
 * per poll — no client-side tween — so the motion reflects real passage of
 * time, not an animation tick.
 */
export function Clock({ progress }: { progress: number }) {
  const p = Math.max(0, Math.min(0.999, progress));
  const angle = p * Math.PI * 2; // radians, clockwise from 12
  const R = 40;
  const CX = 50;
  const CY = 50;

  // Hand tip (slightly shorter than the outer ring).
  const HAND = 34;
  const handX = CX + HAND * Math.sin(angle);
  const handY = CY - HAND * Math.cos(angle);

  // Filled arc endpoint on the outer ring.
  const arcEndX = CX + R * Math.sin(angle);
  const arcEndY = CY - R * Math.cos(angle);
  const largeArc = angle > Math.PI ? 1 : 0;

  // Pie-slice path: center → 12 o'clock → clockwise arc → back to center.
  const arcPath =
    p > 0
      ? `M ${CX} ${CY} L ${CX} ${CY - R} A ${R} ${R} 0 ${largeArc} 1 ${arcEndX} ${arcEndY} Z`
      : "";

  // Twelve hour ticks.
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2;
    const inner = i % 3 === 0 ? R - 5 : R - 3;
    const outer = R - 0.5;
    return (
      <line
        key={i}
        x1={CX + inner * Math.sin(a)}
        y1={CY - inner * Math.cos(a)}
        x2={CX + outer * Math.sin(a)}
        y2={CY - outer * Math.cos(a)}
        className={i % 3 === 0 ? styles.clockTickMajor : styles.clockTick}
      />
    );
  });

  return (
    <svg
      className={styles.clock}
      viewBox="0 0 100 100"
      width="140"
      height="140"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="clockGlow" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor="rgba(212, 163, 99, 0.25)" />
          <stop offset="60%" stopColor="rgba(212, 163, 99, 0.08)" />
          <stop offset="100%" stopColor="rgba(212, 163, 99, 0)" />
        </radialGradient>
        <filter id="clockBlur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>

      {/* Outer aura — warms the whole pane. */}
      <circle cx={CX} cy={CY} r="48" fill="url(#clockGlow)" />

      {/* Swept arc: the filled-in, already-passed time. */}
      {arcPath && <path d={arcPath} className={styles.clockArc} />}

      {/* Soft glow version of the arc — a bleed of light behind it. */}
      {arcPath && (
        <path
          d={arcPath}
          className={styles.clockArcGlow}
          filter="url(#clockBlur)"
        />
      )}

      {/* Outer ring. */}
      <circle cx={CX} cy={CY} r={R} className={styles.clockRing} />

      {/* Hour ticks. */}
      {ticks}

      {/* The single hand. */}
      <line
        x1={CX}
        y1={CY}
        x2={handX}
        y2={handY}
        className={styles.clockHand}
      />
      {/* Glowing halo at the hand's tip. */}
      <circle
        cx={handX}
        cy={handY}
        r="1.6"
        className={styles.clockHandTip}
      />
      {/* Center pin. */}
      <circle cx={CX} cy={CY} r="1.2" className={styles.clockPin} />
    </svg>
  );
}
