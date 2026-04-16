/**
 * Schema for seen. Applied via POST /api/admin/init-db once, right after
 * provisioning the Neon database.
 *
 * Design notes:
 *
 * - One table. Everything about "a submission" — including whether it has
 *   been scheduled and whether its content has been wiped — lives here.
 *
 * - `token` is an opaque random string the submitter receives once. It is
 *   the ONLY handle they have to come back and check their status. We never
 *   send it anywhere else. Think "bookmarkable magic link."
 *
 * - `client_id` is the browser-generated UUID from localStorage. Used only
 *   for the homepage's "you" state (have you already submitted today?). It
 *   isn't PII and isn't linked to email.
 *
 * - `content_hash` dedups repeat submissions with identical answers. We
 *   hash country+precious+message+photo-digest, so trivial variations still
 *   go through.
 *
 * - `scheduled_for` is a timestamp pinned to a cycle boundary (default:
 *   midnight UTC). UNIQUE so at most one submission is "seen" per cycle.
 *   NULLs are allowed to coexist (Postgres treats NULL != NULL in UNIQUE).
 *
 * - `content_cleared_at` is set once the 15-minute fame window has passed
 *   and we've nulled out the text/photo fields. The row stays for a year
 *   after submitted_at so duplicate content can still be caught; then it
 *   is deleted entirely.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS submissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token              TEXT NOT NULL UNIQUE,
  client_id          TEXT NOT NULL,

  country            TEXT,
  precious           TEXT,
  message            TEXT,
  photo              TEXT,
  content_hash       TEXT,

  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_for      TIMESTAMPTZ UNIQUE,
  content_cleared_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_submissions_pool
  ON submissions (submitted_at)
  WHERE scheduled_for IS NULL AND content_cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_client
  ON submissions (client_id);

CREATE INDEX IF NOT EXISTS idx_submissions_content_hash
  ON submissions (content_hash)
  WHERE content_cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at
  ON submissions (submitted_at);
`;
