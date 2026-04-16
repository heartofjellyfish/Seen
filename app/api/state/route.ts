import { NextRequest, NextResponse } from "next/server";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const clientId = req.headers.get("x-client-id");
  const state = getState(clientId);
  return NextResponse.json(state, {
    headers: { "cache-control": "no-store" },
  });
}
