import type {
  Answers,
  Participant,
  StateResponse,
  UserStatus,
} from "./types";
import {
  hashAnswers,
  hasContent,
  isDuplicate,
  recordSubmission,
} from "./archive";

/**
 * Cycle configuration.
 *
 *   SEEN_CYCLE_MS       — X, one full cycle (default 24h). Every X ms, one
 *                         person gets their moment.
 *   SEEN_DURATION_MS    — Y, how long a fame window is within a cycle
 *                         (default 15m). Clamped to X.
 *   SEEN_PREP_GRACE_MS  — P, how long the chosen person has to submit their
 *                         answers before we quietly move on (default 3m).
 *   SEEN_DEMO=1         — pre-seed a demo person AND auto-set X=Y so the
 *                         reveal is always visible (no "quiet hours").
 *
 * Invariant enforced: 0 < P, P < Y, Y <= X.
 *
 * Cycles are anchored to Unix epoch — cycleStart = floor(now/X)*X. For X=24h
 * this is midnight UTC. Timezone shift will be added as SEEN_CYCLE_OFFSET_MS
 * when someone asks for it.
 */
const DEMO = process.env.SEEN_DEMO === "1";

const RAW_CYCLE_MS =
  Number(process.env.SEEN_CYCLE_MS) || 24 * 60 * 60 * 1000;
const RAW_DURATION_MS =
  Number(process.env.SEEN_DURATION_MS) || 15 * 60 * 1000;

// In demo mode, collapse the quiet phase so you always see someone.
const SEEN_CYCLE_MS = DEMO ? RAW_DURATION_MS : RAW_CYCLE_MS;
const SEEN_DURATION_MS = Math.min(RAW_DURATION_MS, SEEN_CYCLE_MS);

const PREP_GRACE_MS = Math.min(
  Number(process.env.SEEN_PREP_GRACE_MS) || 3 * 60 * 1000,
  Math.max(SEEN_DURATION_MS - 5_000, 1_000),
);

// Queue entries survive across two cycles so nobody has to re-sign-up
// every single day to stay eligible.
const QUEUE_TTL_MS = Math.max(SEEN_CYCLE_MS * 2, 60 * 60 * 1000);

// Per-field caps. All optional; trimmed server-side.
const LIMITS = {
  country: 60,
  precious: 140,
  message: 140,
} as const;

interface CurrentSeen {
  participant: Participant;
  selectedAt: number;
  endTime: number; // selectedAt + SEEN_DURATION_MS
  readyAt?: number; // when the selected user submitted answers
  answers?: Answers;
}

interface StoreShape {
  queue: Participant[];
  current: CurrentSeen | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __seenStore: StoreShape | undefined;
}

const store: StoreShape =
  globalThis.__seenStore ??
  (globalThis.__seenStore = { queue: [], current: null });

// Seed a demo person on module init when SEEN_DEMO=1. Lets you watch the
// whole ceremonial reveal solo without spinning up two browsers.
if (process.env.SEEN_DEMO === "1" && !store.current) {
  const now = Date.now();
  // Small warm abstract gradient — stands in for a real photograph.
  const demoPhoto =
    "data:image/svg+xml;base64," +
    Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600' viewBox='0 0 600 600'>" +
        "<defs><radialGradient id='g' cx='48%' cy='42%' r='65%'>" +
        "<stop offset='0%' stop-color='#e8c089'/>" +
        "<stop offset='45%' stop-color='#8e6a3d'/>" +
        "<stop offset='100%' stop-color='#14100a'/>" +
        "</radialGradient></defs>" +
        "<rect width='600' height='600' fill='url(#g)'/>" +
        "</svg>",
    ).toString("base64");

  store.current = {
    participant: { id: "demo", joinedAt: now },
    selectedAt: now,
    endTime: now + SEEN_DURATION_MS,
    readyAt: now,
    answers: {
      country: "Kyoto, Japan",
      precious: "my grandmother's hands, folded in her lap",
      message: "be gentle with each other",
      photo: demoPhoto,
    },
  };
}

/** Cycle boundaries anchored to Unix epoch. */
function cycleBounds(now: number) {
  const cycleStart = Math.floor(now / SEEN_CYCLE_MS) * SEEN_CYCLE_MS;
  return {
    cycleStart,
    fameEnd: cycleStart + SEEN_DURATION_MS,
    cycleEnd: cycleStart + SEEN_CYCLE_MS,
  };
}

function rotate(now: number) {
  const { fameEnd } = cycleBounds(now);

  if (store.current) {
    if (now >= store.current.endTime) {
      store.current = null;
    } else if (
      !store.current.readyAt &&
      now - store.current.selectedAt > PREP_GRACE_MS
    ) {
      // Selected user didn't finish in time — skip quietly.
      store.current = null;
    }
  }

  store.queue = store.queue.filter((p) => now - p.joinedAt < QUEUE_TTL_MS);

  // Only promote during the fame window. Everyone this cycle shares the same
  // endTime (cycleStart + Y), so picks later in the cycle get shorter fame —
  // missing the start of your own cycle has a cost.
  if (!store.current && now < fameEnd && store.queue.length > 0) {
    const idx = Math.floor(Math.random() * store.queue.length);
    const [picked] = store.queue.splice(idx, 1);
    store.current = {
      participant: picked,
      selectedAt: now,
      endTime: fameEnd,
    };
  }
}

export function join(clientId: string) {
  const now = Date.now();
  store.queue = store.queue.filter((p) => p.id !== clientId);
  if (store.current?.participant.id === clientId) return;
  store.queue.push({ id: clientId, joinedAt: now });
}

function trimField(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, max);
  return t ? t : undefined;
}

export function prepare(
  clientId: string,
  raw: Record<string, unknown>,
): {
  ok: boolean;
  reason?: "not_selected" | "already_ready" | "duplicate";
} {
  if (!store.current || store.current.participant.id !== clientId) {
    return { ok: false, reason: "not_selected" };
  }
  if (store.current.readyAt) {
    return { ok: false, reason: "already_ready" };
  }

  const answers: Answers = {
    country: trimField(raw.country, LIMITS.country),
    precious: trimField(raw.precious, LIMITS.precious),
    message: trimField(raw.message, LIMITS.message),
    photo:
      typeof raw.photo === "string" && raw.photo.startsWith("data:image/")
        ? raw.photo
        : undefined,
  };

  // Dedup against the 7-day archive, but only for submissions that actually
  // say something. "Empty" answers are allowed to repeat freely — otherwise
  // the second silent person would be unfairly blocked.
  if (hasContent(answers)) {
    const hash = hashAnswers(answers);
    if (isDuplicate(hash)) {
      return { ok: false, reason: "duplicate" };
    }
    recordSubmission(clientId, hash);
  }

  store.current.answers = answers;
  store.current.readyAt = Date.now();
  return { ok: true };
}

/**
 * Coarse, non-gameable progress through the quiet hours.
 * Returns a fraction in [0, 1] rounded to 1% — fine enough for an hourglass
 * to visibly creep across a day, coarse enough that refreshing can't reveal
 * a precise countdown. For a 24h cycle, 1% ≈ 14 minutes.
 */
function quietProgress(now: number, fameEnd: number, cycleEnd: number): number {
  const total = cycleEnd - fameEnd;
  if (total <= 0) return 0;
  const raw = (now - fameEnd) / total;
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * 100) / 100;
}

/**
 * Progress through the current cycle, [0, 1], bucketed to 1%. Full circle
 * of the waiting clock = one X. Same anti-gaming precision as above.
 */
function cycleProgress(now: number, cycleStart: number): number {
  const raw = (now - cycleStart) / SEEN_CYCLE_MS;
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * 100) / 100;
}

export function getState(clientId: string | null): StateResponse {
  const now = Date.now();
  rotate(now);
  const { cycleStart, fameEnd, cycleEnd } = cycleBounds(now);

  let you: UserStatus = "idle";
  if (clientId && store.current?.participant.id === clientId) {
    you = store.current.readyAt ? "seen" : "summoned";
  } else if (clientId && store.queue.some((p) => p.id === clientId)) {
    you = "waiting";
  }

  // Waiting users get a cycle-progress clock. The rest don't need it (they
  // either see the hourglass, the reveal, or the fleeting idle pane).
  const withClock = <T extends StateResponse>(r: T): T =>
    you === "waiting"
      ? { ...r, cycleProgress: cycleProgress(now, cycleStart) }
      : r;

  if (store.current) {
    if (!store.current.readyAt) return withClock({ phase: "preparing", you });
    return withClock({
      phase: "seen",
      you,
      seen: {
        revealElapsedMs: now - store.current.readyAt,
        answers: store.current.answers ?? {},
      },
    });
  }

  // Nobody is currently seen. Either we're still inside the fame window
  // (and the queue is empty), or we're past it and in the quiet hours.
  if (now >= fameEnd) {
    return withClock({
      phase: "quiet",
      you,
      nextProgress: quietProgress(now, fameEnd, cycleEnd),
    });
  }
  return withClock({ phase: "idle", you });
}

// Clap is intentionally a write-only, unmeasured gesture.
export function clap(_clientId: string | null) {
  // no-op by design
}
