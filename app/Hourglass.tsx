"use client";

import styles from "./page.module.css";

/**
 * A minimalist hourglass. `progress` is in [0, 1] — the fraction of the
 * quiet hours already elapsed. Sand in the top bulb drains, a pile grows
 * in the bottom. Deliberately small, deliberately imprecise.
 *
 * Intentionally a static snapshot per poll — no smooth tweening — because
 * the server already bucketed `progress` to ~1%. Faking smoothness here
 * would only invite people to stare.
 */
export function Hourglass({ progress }: { progress: number }) {
  const p = Math.max(0, Math.min(1, progress));

  // Geometry of the two triangles (shared apex at y=30):
  //   top funnel:    (5,5) (35,5) (20,30)   — sand drains downward
  //   bottom funnel: (5,55)(35,55)(20,30)   — sand piles upward
  // Sand surface in top bulb drops from y=5 → y=30 as p goes 0 → 1.
  // Pile surface in bottom bulb rises from y=55 → y=30 symmetrically.
  const topY = 5 + 25 * p;
  const topDx = 15 * p; // inset of the sand's top edge from the funnel rim

  const botY = 55 - 25 * p;
  const botDx = 15 * p;

  // Top sand: trapezoid shrinking toward the neck.
  const topSand = `${5 + topDx},${topY} ${35 - topDx},${topY} ${20},30`;
  // Bottom sand: trapezoid growing up from the base.
  const botSand = `${5},55 ${35},55 ${35 - botDx},${botY} ${5 + botDx},${botY}`;

  return (
    <svg
      className={styles.hourglass}
      viewBox="0 0 40 60"
      width="28"
      height="42"
      aria-hidden="true"
    >
      {/* Top cap and bottom cap — short amber serifs. */}
      <line x1="5" y1="5" x2="35" y2="5" className={styles.hgFrame} />
      <line x1="5" y1="55" x2="35" y2="55" className={styles.hgFrame} />
      {/* Funnels. */}
      <polygon points="5,5 35,5 20,30" className={styles.hgFrame} />
      <polygon points="5,55 35,55 20,30" className={styles.hgFrame} />
      {/* Sand. */}
      {p < 1 && <polygon points={topSand} className={styles.hgSand} />}
      {p > 0 && <polygon points={botSand} className={styles.hgSand} />}
      {/* A single grain, falling through the neck — motion, not measurement. */}
      {p > 0 && p < 1 && (
        <circle
          cx="20"
          cy="30"
          r="0.7"
          className={styles.hgGrain}
        />
      )}
    </svg>
  );
}
