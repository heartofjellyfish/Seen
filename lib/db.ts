import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Postgres connection. Vercel's Neon integration injects any of
 *   DATABASE_URL, POSTGRES_URL, POSTGRES_PRISMA_URL
 * depending on how the project was wired up. We pick whichever exists.
 *
 * The driver uses HTTP fetch (not a socket), so it's safe in serverless.
 * Each call is a discrete request; there is no connection pool to manage.
 */
const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  "";

let _sql: NeonQueryFunction<false, false> | null = null;

function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL / POSTGRES_URL is not set. Provision Neon via Vercel → Storage and redeploy.",
      );
    }
    _sql = neon(connectionString);
  }
  return _sql;
}

/**
 * Tagged-template SQL helper. Mirrors the Neon driver's API but with lazy
 * initialization so importing this file at build time (when env vars may be
 * absent) doesn't crash.
 *
 *   const rows = await sql`SELECT * FROM submissions WHERE id = ${id}`;
 */
export const sql: NeonQueryFunction<false, false> = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  return getSql()(strings, ...values);
}) as NeonQueryFunction<false, false>;

export function hasDatabase(): boolean {
  return Boolean(connectionString);
}
