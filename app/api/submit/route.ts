import { NextRequest, NextResponse } from "next/server";
import { MAX_SUBMISSION_BYTES, submit } from "@/lib/submissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Anonymous submission. Any visitor can POST their answers; the response
 * carries a one-shot `token` they're expected to bookmark as /mine/[token].
 *
 * The client also sends `x-client-id` so we can enforce one pending
 * submission per browser (not PII — just a local UUID).
 */
export async function POST(req: NextRequest) {
  const clientId = req.headers.get("x-client-id");
  if (!clientId) {
    return NextResponse.json({ ok: false, reason: "no_client" }, { status: 400 });
  }

  const raw = await req.text();
  if (raw.length > MAX_SUBMISSION_BYTES) {
    return NextResponse.json({ ok: false, reason: "too_large" }, { status: 413 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }

  const result = await submit(clientId, body);
  if (!result.ok) {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(
    { ok: true, token: result.token },
    { headers: { "cache-control": "no-store" } },
  );
}
