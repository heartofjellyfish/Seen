"use client";

import styles from "./page.module.css";
import type { StateResponse } from "@/lib/types";

/**
 * A back-door state switcher. Purely client-side — it replaces the rendered
 * `remote` without touching the server store. Toggling it off resumes the
 * real poll immediately.
 *
 * Enabled via `?debug` in the URL or `NEXT_PUBLIC_SEEN_DEBUG_PANEL=1` at build.
 */

const FAKE_PHOTO =
  "data:image/svg+xml;base64," +
  (typeof window !== "undefined"
    ? window.btoa(
        "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'>" +
          "<defs><radialGradient id='g' cx='48%' cy='42%' r='65%'>" +
          "<stop offset='0%' stop-color='#e8c089'/>" +
          "<stop offset='45%' stop-color='#8e6a3d'/>" +
          "<stop offset='100%' stop-color='#14100a'/>" +
          "</radialGradient></defs>" +
          "<rect width='600' height='600' fill='url(#g)'/></svg>",
      )
    : "");

const FAKE_ANSWERS = {
  country: "Kyoto, Japan",
  precious: "my grandmother's hands, folded in her lap",
  message: "be gentle with each other",
  photo: FAKE_PHOTO,
};

export type DebugMode =
  | "off"
  | "idle"
  | "quiet"
  | "waiting"
  | "summoned"
  | "seen";

export function modeToState(mode: DebugMode): StateResponse | null {
  switch (mode) {
    case "off":
      return null;
    case "idle":
      return { phase: "idle", you: "idle" };
    case "quiet":
      return { phase: "quiet", you: "idle", nextProgress: 0.37 };
    case "waiting":
      return { phase: "preparing", you: "waiting", cycleProgress: 0.42 };
    case "summoned":
      return { phase: "preparing", you: "summoned" };
    case "seen":
      return {
        phase: "seen",
        you: "idle",
        seen: { revealElapsedMs: 0, answers: FAKE_ANSWERS },
      };
  }
}

const MODES: { mode: DebugMode; label: string }[] = [
  { mode: "off", label: "live" },
  { mode: "idle", label: "idle" },
  { mode: "quiet", label: "quiet" },
  { mode: "waiting", label: "waiting" },
  { mode: "summoned", label: "summoned" },
  { mode: "seen", label: "seen" },
];

export function DebugPanel({
  mode,
  setMode,
}: {
  mode: DebugMode;
  setMode: (m: DebugMode) => void;
}) {
  return (
    <div className={styles.debugPanel} aria-label="debug">
      <span className={styles.debugTitle}>debug</span>
      {MODES.map((m) => (
        <button
          key={m.mode}
          className={
            mode === m.mode
              ? `${styles.debugChip} ${styles.debugChipActive}`
              : styles.debugChip
          }
          onClick={() => setMode(m.mode)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
