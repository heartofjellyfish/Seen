import crypto from "node:crypto";
import { sql } from "./db";
import {
  LIMITS,
  SEEN_CYCLE_MS,
  SEEN_DURATION_MS,
  cycleBoundsAt,
  cycleProgress,
  quietProgress,
  nextCycleStart,
} from "./cycle";
import type {
  Answers,
  MineResponse,
  StateResponse,
  UserStatus,
} from "./types";

/**
 * Content retention. 15 minutes after the fame window begins, we null out
 * the text and photo fields. The row itself stays for a year after submitted_at
 * so duplicate-content dedup still works, then gets deleted entirely.
 */
const CONTENT_RETENTION_MS = SEEN_DURATION_MS;
const ROW_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** Max submission body (photo is a JPEG data URL, bounded by the client). */
export const MAX_SUBMISSION_BYTES = 1_500_000;

// ————————————————————————————————————————————————————————————————
// row shape
// ————————————————————————————————————————————————————————————————

interface SubmissionRow {
  id: string;
  token: string;
  client_id: string;
  country: string | null;
  precious: string | null;
  message: string | null;
  photo: string | null;
  content_hash: string | null;
  submitted_at: string; // ISO from Postgres
  scheduled_for: string | null;
  content_cleared_at: string | null;
}

function rowToAnswers(r: SubmissionRow): Answers {
  return {
    country: r.country ?? undefined,
    precious: r.precious ?? undefined,
    message: r.message ?? undefined,
    photo: r.photo ?? undefined,
  };
}

// ————————————————————————————————————————————————————————————————
// input sanitation
// ————————————————————————————————————————————————————————————————

function trimField(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t ? t : null;
}

function sanitizePhoto(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (!v.startsWith("data:image/")) return null;
  return v;
}

/** Canonicalize + hash a set of answers. Empty fields contribute nothing. */
function hashAnswers(a: Answers): string | null {
  if (!a.country && !a.precious && !a.message && !a.photo) return null;
  const photoDigest = a.photo
    ? crypto.createHash("sha256").update(a.photo).digest("hex")
    : "";
  const parts = [a.country, a.precious, a.message, photoDigest]
    .map((s) => (s ?? "").trim().toLowerCase());
  return crypto.createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

function generateToken(): string {
  // 24 bytes → 32 char base64url — long enough to be unguessable, short
  // enough to live in a URL comfortably.
  return crypto.randomBytes(24).toString("base64url");
}

// ————————————————————————————————————————————————————————————————
// submit
// ————————————————————————————————————————————————————————————————

export type SubmitResult =
  | { ok: true; token: string }
  | { ok: false; reason: "duplicate" | "empty" | "already_pending" };

/**
 * Accept a new submission. Returns the opaque token the submitter should
 * bookmark as /mine/[token]. Enforces:
 *
 * - Non-empty (at least one field)
 * - Not identical to another active, un-cleared submission (content dedup)
 * - One pending submission per clientId (re-submitting replaces; simpler: reject)
 */
export async function submit(
  clientId: string,
  raw: Record<string, unknown>,
): Promise<SubmitResult> {
  const answers: Answers = {
    country: trimField(raw.country, LIMITS.country) ?? undefined,
    precious: trimField(raw.precious, LIMITS.precious) ?? undefined,
    message: trimField(raw.message, LIMITS.message) ?? undefined,
    photo: sanitizePhoto(raw.photo) ?? undefined,
  };

  const hash = hashAnswers(answers);
  if (!hash) return { ok: false, reason: "empty" };

  // Content-hash dedup. Only checks active submissions (not content-cleared
  // rows) so after a year, identical submissions can reappear.
  const existing = await sql`
    SELECT 1 FROM submissions
    WHERE content_hash = ${hash} AND content_cleared_at IS NULL
    LIMIT 1
  ` as unknown[];
  if (existing.length > 0) {
    return { ok: false, reason: "duplicate" };
  }

  // One pending-or-scheduled submission per clientId. If they want a second
  // shot, they need to wait for the first to be seen-and-cleared.
  const pending = await sql`
    SELECT 1 FROM submissions
    WHERE client_id = ${clientId} AND content_cleared_at IS NULL
    LIMIT 1
  ` as unknown[];
  if (pending.length > 0) {
    return { ok: false, reason: "already_pending" };
  }

  const token = generateToken();
  await sql`
    INSERT INTO submissions
      (token, client_id, country, precious, message, photo, content_hash)
    VALUES
      (${token}, ${clientId},
       ${answers.country ?? null}, ${answers.precious ?? null},
       ${answers.message ?? null}, ${answers.photo ?? null},
       ${hash})
  `;

  return { ok: true, token };
}

// ————————————————————————————————————————————————————————————————
// selection: pick one random unscheduled submission for this cycle
// ————————————————————————————————————————————————————————————————

/**
 * Atomically schedule one random pool submission for the given cycle.
 *
 * Safety:
 * - `scheduled_for` has UNIQUE constraint → only one row can win per cycle.
 * - If two callers race, one wins, the other hits the unique violation
 *   (caught and ignored) and re-reads whoever did win.
 */
export async function pickForCycle(
  cycleStart: Date,
): Promise<SubmissionRow | null> {
  try {
    const rows = (await sql`
      UPDATE submissions
      SET scheduled_for = ${cycleStart.toISOString()}
      WHERE id = (
        SELECT id FROM submissions
        WHERE scheduled_for IS NULL AND content_cleared_at IS NULL
        ORDER BY RANDOM()
        LIMIT 1
      )
      RETURNING *
    `) as SubmissionRow[];
    if (rows[0]) return rows[0];
  } catch (e: unknown) {
    // unique_violation on scheduled_for — someone else scheduled first.
    // Fall through to re-read.
    const code = (e as { code?: string })?.code;
    if (code !== "23505") throw e;
  }

  const rows = (await sql`
    SELECT * FROM submissions WHERE scheduled_for = ${cycleStart.toISOString()}
  `) as SubmissionRow[];
  return rows[0] ?? null;
}

// ————————————————————————————————————————————————————————————————
// retention: wipe content, purge old rows
// ————————————————————————————————————————————————————————————————

/**
 * Null out text/photo fields for any submission whose fame window ended
 * more than a minute ago. Idempotent — safe to call from every state read
 * as well as from the nightly cron.
 */
export async function expireContent(now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - CONTENT_RETENTION_MS - 60_000,
  ).toISOString();
  const rows = (await sql`
    UPDATE submissions
    SET country = NULL, precious = NULL, message = NULL, photo = NULL,
        content_cleared_at = NOW()
    WHERE scheduled_for IS NOT NULL
      AND scheduled_for < ${cutoff}
      AND content_cleared_at IS NULL
    RETURNING id
  `) as unknown[];
  return rows.length;
}

/** Delete rows older than the 1-year retention window. */
export async function purgeOldRows(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - ROW_RETENTION_MS).toISOString();
  const rows = (await sql`
    DELETE FROM submissions WHERE submitted_at < ${cutoff}
    RETURNING id
  `) as unknown[];
  return rows.length;
}

// ————————————————————————————————————————————————————————————————
// reads
// ————————————————————————————————————————————————————————————————

/** The currently-scheduled submission for this cycle, if any. */
async function getCurrentCycleSubmission(
  cycleStart: Date,
): Promise<SubmissionRow | null> {
  const rows = (await sql`
    SELECT * FROM submissions
    WHERE scheduled_for = ${cycleStart.toISOString()}
    LIMIT 1
  `) as SubmissionRow[];
  return rows[0] ?? null;
}

/** Whatever this clientId has in the system right now, if anything. */
async function getClientPendingSubmission(
  clientId: string,
): Promise<SubmissionRow | null> {
  const rows = (await sql`
    SELECT * FROM submissions
    WHERE client_id = ${clientId} AND content_cleared_at IS NULL
    ORDER BY submitted_at DESC
    LIMIT 1
  `) as SubmissionRow[];
  return rows[0] ?? null;
}

/**
 * Lookup a submission by its bookmark token. Public — returns exactly
 * enough for the /mine/[token] page, no client_id leaked.
 */
export async function findByToken(
  token: string,
  now: Date,
): Promise<MineResponse | null> {
  const rows = (await sql`
    SELECT submitted_at, scheduled_for, content_cleared_at,
           country, precious, message, photo
    FROM submissions
    WHERE token = ${token}
    LIMIT 1
  `) as Array<{
    submitted_at: string;
    scheduled_for: string | null;
    content_cleared_at: string | null;
    country: string | null;
    precious: string | null;
    message: string | null;
    photo: string | null;
  }>;
  const row = rows[0];
  if (!row) return null;

  const bounds = cycleBoundsAt(now);
  const scheduled = row.scheduled_for ? new Date(row.scheduled_for) : null;

  let status: MineResponse["status"];
  if (row.content_cleared_at) {
    status = "expired";
  } else if (!scheduled) {
    status = "pool";
  } else if (scheduled > now) {
    status = "scheduled";
  } else if (
    scheduled.getTime() === bounds.cycleStart.getTime() &&
    now < bounds.fameEnd
  ) {
    status = "showing";
  } else {
    status = "past";
  }

  const answers: Answers | null = row.content_cleared_at
    ? null
    : {
        country: row.country ?? undefined,
        precious: row.precious ?? undefined,
        message: row.message ?? undefined,
        photo: row.photo ?? undefined,
      };

  return {
    submittedAt: row.submitted_at,
    scheduledFor: row.scheduled_for,
    status,
    answers,
  };
}

// ————————————————————————————————————————————————————————————————
// getState: the shape /api/state returns
// ————————————————————————————————————————————————————————————————

/**
 * Opportunistic maintenance + state derivation, all in one. Called from
 * /api/state and /api/cron/maintain. Every read doubles as a chance to
 * clean up stale content and to pick today's winner if the cron missed.
 */
export async function getState(
  clientId: string | null,
): Promise<StateResponse> {
  const now = new Date();
  const bounds = cycleBoundsAt(now);

  // (a) Lazy content expiry. Cheap UPDATE — touches only rows that need it.
  await expireContent(now).catch(() => {
    /* non-critical; swallow so state read never fails on cleanup */
  });

  // (b) Find today's scheduled submission. If none yet AND we're in the
  //     fame window, try to pick one now.
  let current = await getCurrentCycleSubmission(bounds.cycleStart);
  if (!current && now < bounds.fameEnd) {
    current = await pickForCycle(bounds.cycleStart);
  }

  // (c) Derive "you" for this clientId.
  let you: UserStatus = "idle";
  let mine: SubmissionRow | null = null;
  if (clientId) {
    if (current && current.client_id === clientId) {
      you = "seen";
      mine = current;
    } else {
      mine = await getClientPendingSubmission(clientId);
      if (mine) you = "waiting";
    }
  }

  // (d) Shape the response. `withExtras` attaches the cycle-clock progress
  //     for waiting users and a nextFetchAt for event-driven clients.
  const withExtras = <T extends StateResponse>(r: T): T => {
    const extra: Partial<StateResponse> = {};
    if (you === "waiting") {
      extra.cycleProgress = cycleProgress(now, bounds);
    }
    extra.nextFetchAt = computeNextFetchAt(now, bounds, r.phase).toISOString();
    return { ...r, ...extra };
  };

  if (current && !current.content_cleared_at) {
    const revealElapsedMs = Math.max(
      0,
      now.getTime() - new Date(current.scheduled_for!).getTime(),
    );
    return withExtras({
      phase: "seen",
      you,
      seen: {
        revealElapsedMs,
        answers: rowToAnswers(current),
      },
    });
  }

  // Nobody currently seen. Either still inside the fame window (the pool
  // was empty) or past it into the quiet hours.
  if (now >= bounds.fameEnd) {
    return withExtras({
      phase: "quiet",
      you,
      nextProgress: quietProgress(now, bounds),
    });
  }
  return withExtras({ phase: "idle", you });
}

/**
 * When should the client come back for fresh state? The goal is one fetch
 * per meaningful transition, not a polling timer. We return the earliest
 * of:
 *   - the next phase boundary (fame end / next cycle)
 *   - the next 1% bucket tick (for the clock/hourglass to advance)
 *   - a sanity ceiling of 5 minutes
 *
 * Always strictly > now, always ≤ 5 min, always rounded to whole seconds.
 */
function computeNextFetchAt(
  now: Date,
  b: { fameEnd: Date; cycleEnd: Date; cycleStart: Date },
  phase: "idle" | "preparing" | "seen" | "quiet",
): Date {
  const t = now.getTime();
  const CEILING = 5 * 60 * 1000;

  const candidates: number[] = [t + CEILING];

  // Phase boundaries.
  if (t < b.fameEnd.getTime()) candidates.push(b.fameEnd.getTime());
  if (t < b.cycleEnd.getTime()) candidates.push(b.cycleEnd.getTime());

  // Bucket tick. We emit coarse 1% progress; next tick is when the
  // underlying fraction crosses a percent boundary.
  if (phase === "quiet") {
    const total = b.cycleEnd.getTime() - b.fameEnd.getTime();
    if (total > 0) {
      const elapsed = t - b.fameEnd.getTime();
      const nextBucket = Math.ceil((elapsed / total) * 100 + 0.0001) / 100;
      candidates.push(b.fameEnd.getTime() + nextBucket * total);
    }
  } else {
    const elapsed = t - b.cycleStart.getTime();
    const nextBucket = Math.ceil((elapsed / SEEN_CYCLE_MS) * 100 + 0.0001) / 100;
    candidates.push(b.cycleStart.getTime() + nextBucket * SEEN_CYCLE_MS);
  }

  let next = Math.min(...candidates.filter((c) => c > t + 1000));
  if (!isFinite(next)) next = t + CEILING;
  if (next > t + CEILING) next = t + CEILING;
  return new Date(Math.ceil(next / 1000) * 1000);
}

// re-export for cron route convenience
export { nextCycleStart };
