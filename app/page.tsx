"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import type { StateResponse } from "@/lib/types";
import { Interview, type InterviewOutcome } from "./Interview";
import { Reveal } from "./Reveal";
import { Stage } from "./Stage";
import { DebugPanel, modeToState, type DebugMode } from "./DebugPanel";

// Safety ceiling between event-driven fetches when the server hasn't given
// us a specific nextFetchAt (network errors, etc). NOT a polling interval.
const FALLBACK_REFRESH_MS = 5 * 60 * 1000;

function getClientId(): string {
  try {
    const existing = localStorage.getItem("seen-id");
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem("seen-id", id);
    return id;
  } catch {
    return "anon";
  }
}

function getSavedToken(): string | null {
  try {
    return localStorage.getItem("seen-token");
  } catch {
    return null;
  }
}

function saveToken(t: string) {
  try {
    localStorage.setItem("seen-token", t);
  } catch {
    /* best-effort */
  }
}

const DEFAULT_REMOTE: StateResponse = { phase: "idle", you: "idle" };

type Local =
  | { kind: "home" }
  | { kind: "interview" }
  | { kind: "just-submitted"; token: string }
  | { kind: "already-pending" };

export default function Page() {
  const [clientId, setClientId] = useState<string>("");
  const [remote, setRemote] = useState<StateResponse>(DEFAULT_REMOTE);
  const [local, setLocal] = useState<Local>({ kind: "home" });
  const [clapped, setClapped] = useState(false);
  const clappedForKey = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ————— debug back-door —————
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugMode, setDebugMode] = useState<DebugMode>("off");

  useEffect(() => {
    setClientId(getClientId());
    const urlDebug =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("debug");
    const envDebug = process.env.NEXT_PUBLIC_SEEN_DEBUG_PANEL === "1";
    setDebugEnabled(urlDebug || envDebug);
  }, []);

  // ————— event-driven fetch —————
  // We fetch on mount, on visibility-change-to-visible, on focus, and at the
  // `nextFetchAt` the server hands us. No setInterval timer.
  const fetchState = useCallback(async () => {
    if (!clientId) return;
    try {
      const res = await fetch("/api/state", {
        headers: { "x-client-id": clientId },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data: StateResponse = await res.json();
      setRemote(data);

      // Schedule the next fetch at whatever the server predicted as the
      // next meaningful transition, clamped by our safety ceiling.
      if (timerRef.current) clearTimeout(timerRef.current);
      let delay = FALLBACK_REFRESH_MS;
      if (data.nextFetchAt) {
        const target = new Date(data.nextFetchAt).getTime();
        delay = Math.max(5_000, Math.min(FALLBACK_REFRESH_MS, target - Date.now()));
      }
      timerRef.current = setTimeout(fetchState, delay);
    } catch {
      // stay calm — try again later
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(fetchState, FALLBACK_REFRESH_MS);
    }
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;
    fetchState();
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchState();
    };
    const onFocus = () => fetchState();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [clientId, fetchState]);

  // Reset "clapped" whenever the active seen person changes.
  useEffect(() => {
    const a = remote?.seen?.answers;
    const key =
      remote?.phase === "seen"
        ? [a?.photo, a?.message, a?.country, a?.precious].join("|")
        : null;
    if (key !== clappedForKey.current) {
      clappedForKey.current = key;
      setClapped(false);
    }
  }, [remote]);

  // ————— actions —————

  const onBeSeen = () => {
    // Flip the local view to the interview. No server call until submit.
    setLocal({ kind: "interview" });
  };

  const onCancelInterview = () => setLocal({ kind: "home" });

  const onSubmitted = (outcome: InterviewOutcome) => {
    if (outcome.kind === "submitted") {
      saveToken(outcome.token);
      setLocal({ kind: "just-submitted", token: outcome.token });
      fetchState(); // reflect "waiting" state on home
    } else if (outcome.kind === "already_pending") {
      setLocal({ kind: "already-pending" });
    } else if (outcome.kind === "duplicate") {
      /* Interview shows inline note; stay in the form */
    } else {
      setLocal({ kind: "home" });
    }
  };

  const onClap = () => {
    // Deliberately client-only — no network call. A private gesture.
    if (clapped) return;
    setClapped(true);
  };

  // ————— render —————

  const override = debugMode !== "off" ? modeToState(debugMode) : null;
  const view: StateResponse = override ?? remote;
  const effectiveClientId = override ? clientId || "debug" : clientId;

  // ————— local overlays always win —————

  if (local.kind === "interview") {
    return (
      <>
        <main className={styles.stage}>
          <Interview
            clientId={effectiveClientId || "anon"}
            onSubmitted={onSubmitted}
            onCancel={onCancelInterview}
          />
        </main>
        {debugEnabled && <DebugPanel mode={debugMode} setMode={setDebugMode} />}
      </>
    );
  }

  if (local.kind === "just-submitted") {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const url = `${origin}/mine/${local.token}`;
    return (
      <>
        <main className={styles.stage}>
          <div className={styles.pane} key="submitted">
            <p className={styles.headline}>It is set aside.</p>
            <p className={styles.youSoft}>
              Save this thread back to yourself. It is the only way.
            </p>
            <div className={styles.bookmarkBox}>
              <a className={styles.bookmarkLink} href={`/mine/${local.token}`}>
                {url}
              </a>
            </div>
            <div className={styles.hairlineAmber} />
            <button
              className={styles.subtle}
              onClick={() => setLocal({ kind: "home" })}
            >
              return
            </button>
          </div>
        </main>
        {debugEnabled && <DebugPanel mode={debugMode} setMode={setDebugMode} />}
      </>
    );
  }

  if (local.kind === "already-pending") {
    const saved = getSavedToken();
    return (
      <>
        <main className={styles.stage}>
          <div className={styles.pane} key="already">
            <p className={styles.headlineDim}>You have already been set down.</p>
            <p className={styles.youSoft}>
              A moment is already waiting for you.
              {saved ? " Your thread:" : ""}
            </p>
            {saved && (
              <div className={styles.bookmarkBox}>
                <a className={styles.bookmarkLink} href={`/mine/${saved}`}>
                  /mine/{saved.slice(0, 12)}…
                </a>
              </div>
            )}
            <button
              className={styles.subtle}
              onClick={() => setLocal({ kind: "home" })}
            >
              return
            </button>
          </div>
        </main>
        {debugEnabled && <DebugPanel mode={debugMode} setMode={setDebugMode} />}
      </>
    );
  }

  // ————— remote view (homepage proper) —————

  let body: React.ReactNode;
  const savedToken = getSavedToken();

  // (a) You are the one being seen.
  if (view.you === "seen" && view.phase === "seen" && view.seen) {
    body = (
      <main className={styles.stage}>
        <div className={styles.pane} key="you-seen">
          <p className={styles.headline}>
            For a while,
            <br />
            you are seen.
          </p>
          <div className={styles.revealStage}>
            <Reveal
              answers={view.seen.answers}
              revealElapsedMs={view.seen.revealElapsedMs}
              onClap={() => {}}
              clapped={false}
            />
          </div>
        </div>
      </main>
    );
  }
  // (b) Someone else is being seen.
  else if (view.phase === "seen" && view.seen) {
    body = (
      <main className={styles.stage}>
        <div className={styles.pane} key="reveal">
          <p className={styles.headlineDim}>Someone is being seen.</p>
          <div className={styles.revealStage}>
            <Reveal
              answers={view.seen.answers}
              revealElapsedMs={view.seen.revealElapsedMs}
              onClap={onClap}
              clapped={clapped}
            />
          </div>
          {view.you === "waiting" ? (
            <p className={styles.you}>maybe soon</p>
          ) : (
            <button className={styles.subtle} onClick={onBeSeen}>
              leave something of your own
            </button>
          )}
        </div>
      </main>
    );
  }
  // (c) You are waiting.
  else if (view.you === "waiting") {
    body = (
      <main className={styles.stage}>
        <div className={styles.pane} key="waiting">
          <Stage
            progress={view.cycleProgress ?? 0}
            epigraph="你的一束光，正在准备。"
            epigraphEn="Your light is being prepared."
          />
          {savedToken && (
            <a className={styles.subtle} href={`/mine/${savedToken}`}>
              your thread
            </a>
          )}
        </div>
      </main>
    );
  }
  // (d) Quiet hours.
  else if (view.phase === "quiet") {
    body = (
      <main className={styles.stage}>
        <div className={styles.pane} key="quiet">
          <Stage
            progress={view.nextProgress ?? 0}
            epigraph="剧院还没醒。"
            epigraphEn="The theater is still asleep."
          />
          <button className={styles.subtle} onClick={onBeSeen}>
            be seen
          </button>
        </div>
      </main>
    );
  }
  // (e) Idle (fame window, pool empty or between transitions).
  else {
    body = (
      <main className={styles.stage}>
        <div className={styles.pane} key="idle">
          <Stage
            progress={view.phase === "preparing" ? 0.95 : 0.5}
            epigraph={
              view.phase === "preparing"
                ? "有一个人，正在走出来。"
                : "有一个座位，留着。"
            }
            epigraphEn={
              view.phase === "preparing"
                ? "Someone is stepping out."
                : "A seat is kept."
            }
          />
          <button className={styles.subtle} onClick={onBeSeen}>
            be seen
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      {body}
      {debugEnabled && (
        <DebugPanel mode={debugMode} setMode={setDebugMode} />
      )}
    </>
  );
}
