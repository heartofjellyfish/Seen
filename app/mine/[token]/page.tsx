import type { Metadata } from "next";
import { findByToken } from "@/lib/submissions";
import { cycleBoundsAt } from "@/lib/cycle";
import styles from "../../page.module.css";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "seen — yours",
  robots: { index: false, follow: false },
};

/**
 * The bookmark page. Only the person who holds the token sees this — it's
 * their one and only "account substitute." Shows status + scheduled time,
 * and — if we've already wiped content — just a gentle acknowledgement.
 *
 * No polling here. A person checks back whenever they remember to; the
 * page reflects a snapshot at load time.
 */
export default async function MinePage({
  params,
}: {
  params: { token: string };
}) {
  const now = new Date();
  const mine = await findByToken(params.token, now).catch(() => null);

  if (!mine) {
    return (
      <main className={styles.stage}>
        <div className={styles.pane} key="mine-missing">
          <p className={styles.headlineDim}>This bookmark isn&apos;t known.</p>
          <p className={styles.youSoft}>
            Either the address is mistyped, or a year has passed and we
            have forgotten.
          </p>
        </div>
      </main>
    );
  }

  // ————— derived copy —————

  const scheduled = mine.scheduledFor ? new Date(mine.scheduledFor) : null;
  const bounds = cycleBoundsAt(now);

  let headline: string;
  let sub: React.ReactNode | null = null;

  switch (mine.status) {
    case "pool":
      headline = "You are held, quietly, among the others.";
      sub = (
        <p className={styles.youSoft}>
          A moment will be chosen for you — you&apos;ll know when you come
          back here.
        </p>
      );
      break;
    case "scheduled":
      headline = "A moment has been set aside for you.";
      sub = scheduled ? (
        <p className={styles.youSoft}>
          <span className={styles.mineWhen}>
            {formatWhen(scheduled, now)}
          </span>
        </p>
      ) : null;
      break;
    case "showing":
      headline = "Right now, you are seen.";
      sub = (
        <p className={styles.youSoft}>
          The home page is showing you. The window closes at{" "}
          {formatClock(bounds.fameEnd)}.
        </p>
      );
      break;
    case "past":
      headline = "Your moment has passed.";
      sub = (
        <p className={styles.youSoft}>
          Thank you for letting yourself be seen.
        </p>
      );
      break;
    case "expired":
      headline = "Your moment has passed, and been let go.";
      sub = (
        <p className={styles.youSoft}>
          The content has been forgotten. Only a shape of you remains,
          until we forget that too.
        </p>
      );
      break;
  }

  return (
    <main className={styles.stage}>
      <div className={styles.pane} key={`mine-${mine.status}`}>
        <p className={styles.headline}>{headline}</p>
        {sub}
        <div className={styles.hairlineAmber} />
        <MineAnswersBlock answers={mine.answers} />
      </div>
    </main>
  );
}

function MineAnswersBlock({
  answers,
}: {
  answers: import("@/lib/types").Answers | null;
}) {
  if (!answers) return null;
  const any =
    answers.country || answers.precious || answers.message || answers.photo;
  if (!any) return null;

  return (
    <div className={styles.mineAnswers}>
      {answers.country && (
        <div className={styles.mineAnswer}>
          <span className={styles.revealLabel}>from</span>
          <p className={styles.revealValue}>{answers.country}</p>
        </div>
      )}
      {answers.precious && (
        <div className={styles.mineAnswer}>
          <span className={styles.revealLabel}>their dearest</span>
          <p className={styles.revealValue}>{answers.precious}</p>
        </div>
      )}
      {answers.message && (
        <p className={styles.revealMessage}>{answers.message}</p>
      )}
      {answers.photo && (
        <div className={styles.revealPhotoWrap} style={{ maxWidth: "14rem" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={answers.photo}
            alt=""
            className={styles.revealPhoto}
            style={{ animation: "none" }}
          />
        </div>
      )}
    </div>
  );
}

/** "in 4 hours", "tomorrow at 00:00 UTC", "in 12 days" — vague by design. */
function formatWhen(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) {
    const mins = Math.max(1, Math.round(ms / 60_000));
    return `in about ${mins} minute${mins === 1 ? "" : "s"}`;
  }
  if (hours < 24) {
    const h = Math.round(hours);
    return `in about ${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `in about ${days} day${days === 1 ? "" : "s"}`;
}

function formatClock(d: Date): string {
  const h = d.getUTCHours().toString().padStart(2, "0");
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m} UTC`;
}
