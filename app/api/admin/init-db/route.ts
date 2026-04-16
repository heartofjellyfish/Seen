import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { SCHEMA_SQL } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One-shot schema bootstrap. Hit this once, right after provisioning Neon.
 * Idempotent — uses CREATE TABLE / INDEX IF NOT EXISTS throughout.
 *
 * Protected by SEEN_INIT_KEY (a random string only you know). Without it,
 * this endpoint refuses. Set it in Vercel → Settings → Environment Variables.
 *
 * Usage:
 *   curl -X POST "https://seen.qi.land/api/admin/init-db?key=<SEEN_INIT_KEY>"
 * or:
 *   curl -X POST -H "x-init-key: <SEEN_INIT_KEY>" \
 *        "https://seen.qi.land/api/admin/init-db"
 */
export async function POST(req: NextRequest) {
  const expected = process.env.SEEN_INIT_KEY;
  if (!expected) {
    return NextResponse.json(
      { ok: false, reason: "SEEN_INIT_KEY env var not set" },
      { status: 500 },
    );
  }

  const provided =
    req.headers.get("x-init-key") ||
    new URL(req.url).searchParams.get("key");
  if (provided !== expected) {
    return NextResponse.json({ ok: false, reason: "bad key" }, { status: 401 });
  }

  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL;
  if (!connectionString) {
    return NextResponse.json(
      { ok: false, reason: "no DATABASE_URL" },
      { status: 500 },
    );
  }

  const sql = neon(connectionString);

  // Neon's HTTP transport accepts only one statement per call, so split
  // the schema on semicolons and run each non-empty statement separately.
  const statements = SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const ran: string[] = [];
  for (const stmt of statements) {
    // sql.query(text, params) is the non-tagged form; perfect for dynamic
    // DDL we don't need to parameterize.
    await sql.query(stmt);
    ran.push(stmt.split("\n")[0]);
  }

  return NextResponse.json({ ok: true, statements: ran });
}

/** GET is a friendly status endpoint for sanity-checking deploys. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    hint:
      "POST this endpoint with ?key=<SEEN_INIT_KEY> (or header x-init-key) to create tables.",
  });
}
