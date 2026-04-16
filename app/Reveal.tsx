"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";
import { REVEAL_ORDER, type Answers } from "@/lib/types";

// How long to linger on each textual answer during the ceremonial intro.
const STEP_MS = 10_000;

/**
 * Plays a slow reveal of a person's answers before showing the final photo
 * + parting message. `revealElapsedMs` is authoritative (from the server);
 * we tick a local clock to smoothly advance between polls.
 */
export function Reveal({
  answers,
  revealElapsedMs,
  onClap,
  clapped,
}: {
  answers: Answers;
  revealElapsedMs: number;
  onClap: () => void;
  clapped: boolean;
}) {
  // Only include questions the person actually answered.
  const steps = useMemo(
    () =>
      REVEAL_ORDER.filter((q) => {
        const v = answers[q.key];
        return typeof v === "string" && v.length > 0;
      }),
    [answers],
  );

  // Re-anchor whenever the server tells us where we are, then let the client
  // tick forward between polls for smoother transitions.
  const [anchor, setAnchor] = useState(() => ({
    serverElapsed: revealElapsedMs,
    at: Date.now(),
  }));
  useEffect(() => {
    setAnchor({ serverElapsed: revealElapsedMs, at: Date.now() });
  }, [revealElapsedMs]);

  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 400);
    return () => clearInterval(id);
  }, []);

  const elapsed = anchor.serverElapsed + (Date.now() - anchor.at);

  const totalIntroMs = steps.length * STEP_MS;
  const introDone = elapsed >= totalIntroMs;
  const stepIndex = Math.min(
    steps.length - 1,
    Math.max(0, Math.floor(elapsed / STEP_MS)),
  );

  // ————— climax: photo + parting message —————
  if (introDone) {
    return (
      <div className={styles.revealCard} key="climax">
        {answers.photo && (
          <div className={styles.revealPhotoWrap}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={answers.photo} alt="" className={styles.revealPhoto} />
          </div>
        )}
        {answers.message && (
          <p className={styles.revealMessage}>{answers.message}</p>
        )}
        <button
          aria-label="clap"
          className={`${styles.clap} ${clapped ? styles.clapped : ""}`}
          onClick={onClap}
        >
          ·
        </button>
      </div>
    );
  }

  // ————— ceremonial intro: one answer at a time —————
  if (steps.length === 0) {
    // No answers at all — just a breath, then the climax (possibly just a photo).
    return (
      <div className={styles.revealCard} key="breath">
        <span className={styles.revealLabel}>·</span>
      </div>
    );
  }

  const step = steps[stepIndex];
  const value = answers[step.key] as string;

  return (
    <div className={styles.revealCard} key={`step-${stepIndex}`}>
      <span className={styles.revealLabel}>{step.label}</span>
      <p className={styles.revealValue}>{value}</p>
    </div>
  );
}
