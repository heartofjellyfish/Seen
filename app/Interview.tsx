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

export function Interview({
  clientId,
  onSubmitted,
}: {
  clientId: string;
  onSubmitted: () => void;
}) {
  const [values, setValues] = useState<Answers>({});
  const [submitting, setSubmitting] = useState(false);
  const [duplicate, setDuplicate] = useState(false);

  const setField = (k: keyof Answers, v: string | undefined) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    // The moment they edit, forget the previous duplicate verdict.
    if (duplicate) setDuplicate(false);
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

  const onSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/prepare", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-client-id": clientId,
        },
        body: JSON.stringify(values),
      });
      if (res.status === 409) {
        const data: { reason?: string } = await res.json().catch(() => ({}));
        if (data.reason === "duplicate") {
          setDuplicate(true);
          return;
        }
      }
      onSubmitted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.pane} key="interview">
      <div className={styles.interview}>
        <div className={styles.interviewIntro}>
          <p className={styles.interviewIntroHeadline}>
            The moment is yours.
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
            {duplicate && (
              <p className={styles.duplicateNote}>
                these words have passed through already. change a little.
              </p>
            )}
            <button
              className={styles.subtle}
              onClick={onSubmit}
              disabled={submitting}
            >
              {submitting ? "…" : "ready"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
