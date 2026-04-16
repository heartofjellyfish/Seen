"use client";

import { useState } from "react";
import styles from "./page.module.css";
import type { Answers } from "@/lib/types";

const QUESTIONS: {
  key: "country" | "precious" | "message";
  label: string;
  placeholder: string;
  max: number;
}[] = [
  {
    key: "country",
    label: "where you are from",
    placeholder: "a country, a city, a room",
    max: 60,
  },
  {
    key: "precious",
    label: "what you hold dearest",
    placeholder: "a person, a thing, a memory",
    max: 140,
  },
  {
    key: "message",
    label: "a word, to whoever is watching",
    placeholder: "",
    max: 140,
  },
];

async function fileToSmallDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const MAX = 1024;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas ctx");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.8);
}

export type InterviewOutcome =
  | { kind: "submitted"; token: string }
  | { kind: "duplicate" }
  | { kind: "already_pending" }
  | { kind: "error" };

/**
 * The submission form. Open to anyone — no "selected" state anymore. On
 * success, we hand back a token; the caller shows the /mine/[token] URL
 * as the person's only handle to come back later.
 */
export function Interview({
  clientId,
  onSubmitted,
  onCancel,
}: {
  clientId: string;
  onSubmitted: (outcome: InterviewOutcome) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<Answers>({});
  const [submitting, setSubmitting] = useState(false);
  const [inlineReason, setInlineReason] = useState<
    "duplicate" | "empty" | null
  >(null);

  const setField = (k: keyof Answers, v: string | undefined) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    if (inlineReason) setInlineReason(null);
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await fileToSmallDataUrl(file);
      setField("photo", url);
    } catch {
      /* ignore */
    }
  };

  const nonEmpty =
    !!values.country || !!values.precious || !!values.message || !!values.photo;

  const onSubmit = async () => {
    if (submitting) return;
    if (!nonEmpty) {
      setInlineReason("empty");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-client-id": clientId,
        },
        body: JSON.stringify(values),
      });
      const data: {
        ok?: boolean;
        token?: string;
        reason?: string;
      } = await res.json().catch(() => ({}));

      if (res.ok && data.ok && data.token) {
        onSubmitted({ kind: "submitted", token: data.token });
        return;
      }
      if (data.reason === "duplicate") {
        setInlineReason("duplicate");
        return;
      }
      if (data.reason === "already_pending") {
        onSubmitted({ kind: "already_pending" });
        return;
      }
      onSubmitted({ kind: "error" });
    } catch {
      onSubmitted({ kind: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.pane} key="interview">
      <div className={styles.interview}>
        <div className={styles.interviewIntro}>
          <p className={styles.interviewIntroHeadline}>
            A moment, set aside for you.
          </p>
          <p className={styles.interviewIntroSub}>
            a few things, if you wish
          </p>
        </div>

        {QUESTIONS.map((q) => (
          <div className={styles.question} key={q.key}>
            <label className={styles.questionLabel} htmlFor={q.key}>
              {q.label}
            </label>
            <input
              id={q.key}
              className={styles.questionInput}
              type="text"
              maxLength={q.max}
              placeholder={q.placeholder}
              value={values[q.key] ?? ""}
              onChange={(e) => setField(q.key, e.target.value)}
            />
          </div>
        ))}

        <div className={styles.question}>
          <span className={styles.questionLabel}>a photograph, if you wish</span>
          <div className={styles.photoRow}>
            <label>
              {values.photo ? "change" : "attach"}
              <input type="file" accept="image/*" onChange={onPickImage} />
            </label>
            {values.photo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={values.photo}
                alt=""
                className={styles.photoPreview}
              />
            )}
          </div>
        </div>

        <div className={styles.actions}>
          <div className={styles.actionsCol}>
            {inlineReason === "duplicate" && (
              <p className={styles.duplicateNote}>
                these words have passed through already. change a little.
              </p>
            )}
            {inlineReason === "empty" && (
              <p className={styles.duplicateNote}>
                a word, a place, a face — anything at all.
              </p>
            )}
            <button
              className={styles.subtle}
              onClick={onSubmit}
              disabled={submitting}
            >
              {submitting ? "…" : "leave it here"}
            </button>
            {onCancel && (
              <button
                className={styles.subtleGhost}
                onClick={onCancel}
                disabled={submitting}
              >
                not now
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
