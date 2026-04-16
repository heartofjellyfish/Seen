import { NextRequest, NextResponse } from "next/server";
import { findByToken } from "@/lib/submissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Bookmarked status lookup. Returns exactly what /mine/[token] needs and
 * nothing more — no client_id, no other submissions.
 *
 * Token is opaque and unguessable; possession IS the authorization.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } },
) {
  const token = params.token;
  if (!token || token.length > 128) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const result = await findByToken(token, new Date());
  if (!result) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  return NextResponse.json(result, {
    headers: { "cache-control": "no-store" },
  });
}
