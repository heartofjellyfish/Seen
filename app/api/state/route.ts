import { NextRequest, NextResponse } from "next/server";
import { getState } from "@/lib/submissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The homepage's only read endpoint. Returns whatever the world should be
 * showing right now — the current seen person, or quiet/idle status —
 * plus this client's own relationship to that (idle / waiting / seen).
 *
 * Called on page load and on visibility/focus changes, not on a polling
 * timer. The response includes `nextFetchAt` so the client knows when the
 * next meaningful transition happens without having to guess.
 */
export async function GET(req: NextRequest) {
  const clientId = req.headers.get("x-client-id");
  try {
    const state = await getState(clientId);
    return NextResponse.json(state, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    // If the DB isn't reachable (first deploy without init, etc.), don't
    // explode the homepage. Return a safe empty idle state. The debug panel
    // can be used to verify UI; the actual problem will show in server logs.
    console.error("[seen/state]", e);
    return NextResponse.json(
      { phase: "idle", you: "idle" },
      {
        status: 200,
        headers: { "cache-control": "no-store", "x-seen-fallback": "1" },
      },
    );
  }
}
