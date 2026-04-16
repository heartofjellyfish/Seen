import { NextRequest, NextResponse } from "next/server";
import {
  expireContent,
  pickForCycle,
  purgeOldRows,
} from "@/lib/submissions";
import { cycleBoundsAt } from "@/lib/cycle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Daily maintenance — triggered by Vercel cron (see vercel.json).
 *
 * Does three things, in order:
 *   1. Clear content for anyone whose fame window has ended (belt + suspenders
 *      — getState() also does this opportunistically).
 *   2. Purge rows past 1-year retention.
 *   3. Pre-schedule today's fame person if not already picked.
 *
 * Safety: Vercel injects `Authorization: Bearer <CRON_SECRET>` on every
 * cron invocation. In production we require it; in development any request
 * is allowed so you can curl it yourself.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const now = new Date();
  const bounds = cycleBoundsAt(now);

  const cleared = await expireContent(now).catch((e) => {
    console.error("[seen/cron] expireContent", e);
    return 0;
  });

  const purged = await purgeOldRows(now).catch((e) => {
    console.error("[seen/cron] purgeOldRows", e);
    return 0;
  });

  // Only try to pick if we're inside this cycle's fame window. Outside it,
  // picking would either set a timestamp in the past (weird) or pre-commit
  // tomorrow's person too early — we'd rather let the next cron run handle it.
  let picked: string | null = null;
  if (now < bounds.fameEnd) {
    const row = await pickForCycle(bounds.cycleStart).catch((e) => {
      console.error("[seen/cron] pickForCycle", e);
      return null;
    });
    picked = row ? row.id : null;
  }

  return NextResponse.json(
    {
      ok: true,
      at: now.toISOString(),
      cycleStart: bounds.cycleStart.toISOString(),
      cleared,
      purged,
      picked,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
