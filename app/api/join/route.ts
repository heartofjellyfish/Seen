import { NextRequest, NextResponse } from "next/server";
import { join } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const clientId = req.headers.get("x-client-id");
  if (!clientId) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  join(clientId);
  // Intentionally vague — no confirmation, no position, no ETA.
  return NextResponse.json(
    { ok: true },
    { headers: { "cache-control": "no-store" } },
  );
}
