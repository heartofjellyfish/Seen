import { NextRequest, NextResponse } from "next/server";
import { clap } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // We accept the gesture and return. No count is kept, no response body.
  clap(req.headers.get("x-client-id"));
  return new NextResponse(null, { status: 204 });
}
