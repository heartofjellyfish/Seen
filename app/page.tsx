"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import type { StateResponse } from "@/lib/types";
import { Interview } from "./Interview";
import { Reveal } from "./Reveal";
import { Hourglass } from "./Hourglass";
import { Clock } from "./Clock";
import { DebugPanel, modeToState, type DebugMode } from "./DebugPanel";

const POLL_MS = 7000;

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

const DEFAULT_REMOTE: StateResponse = { phase: "idle", you: "idle" };

export default function Page() {
  const [clientId, setClientId] = useState<string>("");
  // Start with a sensible default so SSR and first paint show the Idle pane
  // instead of a blank screen while we wait for the first poll.
  const [remote, setRemote] = useState<StateResponse>(DEFAULT_REMOTE);
  const [clapped, setClapped] = useState(false);
  const clappedForKey = useRef<string | null>(null);

  // ————— debug back-door —————
  // Enabled via ?debug URL param or NEXT_PUBLIC_SEEN_DEBUG_PANEL=1. Purely
  // client-side — overrides what we render without touching the server store.
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

  const poll = useCallback(async () => {
    if (!clientId) return;
    try {
      const res = await fetch("/api/state", {
        headers: { "x-client-id": clientId },
        cache: "no-store",
      });
      if (!res.ok) return;
      const data: StateResponse = await res.json();
      setRemote(data);
    } catch {
      // stay calm
    }
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [clientId, poll]);

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

  const onJoin = async () => {
    if (!clientId) return;
    // Optimistic: flip to "waiting" immediately so the tap feels instant.
    // The next poll will reconcile with the server's view of the world.
    setRemote((prev) => (prev.you === "idle" ? { ...prev, you: "waiting" } : prev));
    try {
      await fetch("/api/join", {
        method: "POST",
        headers: { "x-client-id": clientId },
      });
    } finally {
      poll();
    }
  };

  const onClap = async () => {
    if (clapped) return;
    setClapped(true);
    try {
      await fetch("/api/clap", {
        method: "POST",
        headers: { "x-client-id": clientId },
      });
    } catch {
      /* gesture is fire-and-forget */
    }
  };

  // ————— render —————

  // `view` is what the page actually renders. When a debug override is set,
  // it replaces `remote` entirely (purely cosmetic — the server's view of
  // the world never changes).
  const override = debugMode !== "off" ? modeToState(debugMode) : null;
  const view: StateResponse = override ?? remote;

  // Interview and "you are seen" both require a valid clientId, so only
  // enter those branches once the client has mounted. In debug mode we let
  // "summoned" through even without a real clientId, using a stub id.
  const effectiveClientId = override ? clientId || "debug" : clientId;

  let body: React.ReactNode;

  // (a) You are summoned — the private interview.
  if (effectiveClientId && view.you === "summoned") {
    body = (
      <main className={styles.stage}>
        <Interview clientId={effectiveClientId} onSubmitted={poll} />
      </main>
    );
  }
  // (b) You are the one being seen.
  else if (view.you === "seen" && view.phase === "seen" && view.seen) {
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
  // (c) Someone else is being seen — the ceremonial reveal.
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
            <button className={styles.subtle} onClick={onJoin}>
              be seen, next
            </button>
          )}
        </div>
      </main>
    );
  }
  // (d) You are waiting.
  else if (view.you === "waiting") {
    body = (
      <main className={styles.stage}>
        <div className={styles.pane} key="waiting">
          <p className={styles.headlineDim}>Maybe soon.</p>
          <Clock progress={view.cycleProgress ?? 0} />
        </div>
      </main>
    );
  }
  // (e) Quiet — we're past the fame window of this cycle. Most-visited state
  //     for daily cycles: 23h45m of "the quiet hours" punctuated by 15m of
  //     being seen.
  else if (view.phase === "quiet") {
    body = (
      <main className={styles.stage}>
        <div className={styles.pane} key="quiet">
          <p className={styles.headlineDim}>The quiet hours.</p>
          {typeof view.nextProgress === "number" && (
            <Hourglass progress={view.nextProgress} />
          )}
          <div className={styles.hairlineAmber} />
          <button className={styles.subtle} onClick={onJoin}>
            be seen
          </button>
        </div>
      </main>
    );
  }
  // (f) Ambient idle — still within the fame window, but either the queue is
  //     empty or someone is privately preparing.
  else {
    body = (
      <main className={styles.stage}>
        <div className={styles.pane} key="idle">
          <p className={styles.headlineDim}>
            {view.phase === "preparing"
              ? "Someone is arriving."
              : "Someone, any moment now."}
          </p>
          <div className={styles.hairlineAmber} />
          <button className={styles.subtle} onClick={onJoin}>
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
