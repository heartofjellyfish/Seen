import { NextRequest, NextResponse } from "next/server";
import { prepare } from "@/lib/store";

export const dynamic = "force-dynamic";

// Accept a generous-but-bounded payload so a compressed image fits.
const MAX_BODY_BYTES = 1_500_000;

export async function POST(req: NextRequest) {
  const clientId = req.headers.get("x-client-id");
  if (!clientId) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false }, { status: 413 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const result = prepare(clientId, body);
  if (!result.ok) {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(
    { ok: true },
    { headers: { "cache-control": "no-store" } },
  );
}
