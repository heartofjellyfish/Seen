export type Phase = "idle" | "preparing" | "seen" | "quiet";
export type UserStatus = "idle" | "waiting" | "summoned" | "seen";

export interface Answers {
  country?: string;
  precious?: string;
  message?: string;
  photo?: string; // data URL
}

// Ordered reveal: one place, one dearest thing — then the photo and the
// parting word take over as the climax. Message is intentionally NOT in
// this list; it appears only in the final frame, alongside the photograph.
export const REVEAL_ORDER: {
  key: "country" | "precious";
  label: string;
}[] = [
  { key: "country", label: "from" },
  { key: "precious", label: "their dearest" },
];

export interface Participant {
  id: string;
  joinedAt: number;
}

export interface SeenPayload {
  // milliseconds since the selected user submitted their answers.
  // Viewers use this to pace the reveal without needing a server clock.
  revealElapsedMs: number;
  answers: Answers;
}

export interface StateResponse {
  phase: Phase;
  seen?: SeenPayload;
  you: UserStatus;
  /**
   * Only present in the "quiet" phase. A deliberately coarse fraction in
   * [0, 1] — how far through the quiet hours we are — bucketed to ~1%
   * so the hourglass has motion without leaking a precise countdown.
   * Refresh-optimization would require sub-bucket resolution we never emit.
   */
  nextProgress?: number;
  /**
   * Progress through the current cycle, [0, 1], bucketed to ~1%. Sent to
   * waiting users so the clock face can sweep a full turn every X ms,
   * "filling" with amber as the next fame window approaches. Same coarse
   * resolution as `nextProgress` for the same anti-gaming reason.
   */
  cycleProgress?: number;
}
