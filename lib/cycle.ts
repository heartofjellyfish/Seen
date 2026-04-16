/**
 * Cycle bookkeeping. A "cycle" is the X-long interval that contains one
 * fame window of Y and then a quiet stretch. Cycles are anchored to Unix
 * epoch — cycleStart = floor(now/X)*X — so with default X=24h the window
 * starts at midnight UTC every day. No timezone shift yet; we'll add
 * SEEN_CYCLE_OFFSET_MS when someone wants it.
 *
 * Invariants: 0 < Y ≤ X.
 */

const RAW_CYCLE_MS =
  Number(process.env.SEEN_CYCLE_MS) || 24 * 60 * 60 * 1000;
const RAW_DURATION_MS =
  Number(process.env.SEEN_DURATION_MS) || 15 * 60 * 1000;

const DEMO = process.env.SEEN_DEMO_MODE === "1";

/** In demo mode, collapse the cycle to just the fame window — always lit. */
export const SEEN_CYCLE_MS = DEMO ? RAW_DURATION_MS : RAW_CYCLE_MS;
export const SEEN_DURATION_MS = Math.min(RAW_DURATION_MS, SEEN_CYCLE_MS);

/** Per-field character caps, trimmed server-side before persisting. */
export const LIMITS = {
  country: 60,
  precious: 140,
  message: 140,
} as const;

export interface CycleBounds {
  /** Start of the current cycle (also: start of its fame window). */
  cycleStart: Date;
  /** When the fame window closes. */
  fameEnd: Date;
  /** Start of the next cycle. */
  cycleEnd: Date;
}

export function cycleBoundsAt(now: Date): CycleBounds {
  const t = now.getTime();
  const cycleStartMs = Math.floor(t / SEEN_CYCLE_MS) * SEEN_CYCLE_MS;
  return {
    cycleStart: new Date(cycleStartMs),
    fameEnd: new Date(cycleStartMs + SEEN_DURATION_MS),
    cycleEnd: new Date(cycleStartMs + SEEN_CYCLE_MS),
  };
}

export function nextCycleStart(now: Date): Date {
  const t = now.getTime();
  return new Date((Math.floor(t / SEEN_CYCLE_MS) + 1) * SEEN_CYCLE_MS);
}

/**
 * Coarse, non-gameable progress through the quiet hours. [0, 1] rounded
 * to 1% — enough motion for an hourglass to creep across a day, coarse
 * enough that refreshing can't reveal a precise countdown.
 */
export function quietProgress(now: Date, b: CycleBounds): number {
  const total = b.cycleEnd.getTime() - b.fameEnd.getTime();
  if (total <= 0) return 0;
  const raw = (now.getTime() - b.fameEnd.getTime()) / total;
  return bucket(raw);
}

/**
 * Progress through the current cycle, [0, 1], bucketed to 1%. A full sweep
 * of the waiting clock = one full cycle.
 */
export function cycleProgress(now: Date, b: CycleBounds): number {
  const raw = (now.getTime() - b.cycleStart.getTime()) / SEEN_CYCLE_MS;
  return bucket(raw);
}

function bucket(raw: number): number {
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * 100) / 100;
}
