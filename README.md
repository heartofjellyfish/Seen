# seen

> one person, seen for a while, every so often.

Every cycle (default 24h), one anonymous person is "seen" for fifteen
minutes. No feeds, no scrolling, no notifications, no accounts, no
followers, no metrics.

## architecture

- **Next.js 14 App Router**, deployed to Vercel.
- **Postgres** (Neon, via Vercel's Storage integration) stores submissions.
- **Bookmark URL** pattern: submitters receive `/mine/<token>` — no email,
  no account. Possession of the token is the only authorization.
- **No polling**: the client fetches on mount, on focus, on visibility
  change, and at the server-hinted `nextFetchAt` for the next meaningful
  transition.

### data shape

Single table, `submissions`. One row per submission; `scheduled_for`
pins it to a cycle boundary when selected. Content is nulled 15 minutes
after the fame window starts; the row itself is deleted after 1 year.

### retention

- **content** (country / precious / message / photo): up to 15 minutes
  after the fame window starts
- **row shape** (timestamps, hash, opaque client_id): 1 year
- **after 1 year**: full row deletion — total forgetting

## first-time setup

1. In Vercel → Storage, create a Neon Postgres database and connect it
   to this project. It will inject `DATABASE_URL` (and a few aliases).
2. Add one env var yourself:
   - `SEEN_INIT_KEY` = any random string (e.g. `openssl rand -hex 16`)
3. Deploy.
4. Create the tables once:
   ```bash
   curl -X POST "https://seen.qi.land/api/admin/init-db?key=$SEEN_INIT_KEY"
   ```
   Returns `{ok: true, statements: [...]}`. Idempotent — safe to re-run.

## run locally

```bash
npm install
npm run dev
```

You'll need a `.env.local` with `DATABASE_URL` pointing at a Postgres
(either `vercel env pull` or a local Neon branch).

## environment variables

| var                              | default    | meaning                                                      |
| -------------------------------- | ---------- | ------------------------------------------------------------ |
| `DATABASE_URL`                   | —          | Postgres connection string (injected by Neon integration)    |
| `SEEN_INIT_KEY`                  | —          | protects `/api/admin/init-db`                                |
| `CRON_SECRET`                    | —          | Vercel injects on cron calls; `/api/cron/maintain` checks it |
| `SEEN_CYCLE_MS`                  | `86400000` | length of a full cycle, X (default 24h)                      |
| `SEEN_DURATION_MS`               | `900000`   | length of the fame window, Y ≤ X (default 15m)               |
| `SEEN_DEMO_MODE`                 | unset      | `=1` collapses cycle to just the fame window                 |
| `NEXT_PUBLIC_SEEN_DEBUG_PANEL`   | unset      | `=1` shows the floating debug panel                          |

Add `?debug` to the URL for the debug panel without env vars.

## cron

A single Vercel cron runs hourly (`/api/cron/maintain`), doing:

1. Null out expired content (fame window + buffer has passed)
2. Delete rows past 1-year retention
3. Pre-schedule this cycle's fame person, if not already picked

The state endpoint also does (1) and (3) opportunistically, so cron is
belt-and-suspenders, not load-bearing.

## manual deploy (when build minutes are exhausted)

Vercel Hobby has a monthly Build Minutes quota. When it's empty, `git
push` still reaches the repo but Vercel silently refuses to build.
Check: Vercel dashboard → Usage → Build Minutes. If it shows `used /
0s` you're out until the 1st of next month, or until you upgrade.

Workaround: build on your laptop, upload the artifact. Vercel's build
server is never invoked, so no minutes are consumed.

```bash
# one-time: link this checkout to the Vercel project
npx vercel login
npx vercel link            # pick your account → existing project → "seen"

# every manual deploy
npx vercel build --prod    # runs next build locally into .vercel/output
npx vercel deploy --prebuilt --prod   # uploads the artifact, aliases prod
```

After a successful `deploy`, the production domain alias moves to the
new deployment automatically — no extra step.

If later you want a fresh token / re-auth: `rm -rf ~/.vercel` and
repeat `vercel login`.
