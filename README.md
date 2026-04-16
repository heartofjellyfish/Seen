# seen

> one person, seen for a while, every so often.

A small web experiment: every cycle (default 24h), one anonymous person
is "seen" for fifteen minutes. No feeds, no scrolling, no notifications,
no accounts, no followers, no metrics.

## status

Prototype. The store is currently in-memory (single-process) — next step
is Postgres-backed persistence with bookmark URLs instead of email.

## run

```bash
npm install
npm run dev
```

Optional env:

| var | default | meaning |
|---|---|---|
| `SEEN_CYCLE_MS` | `86400000` | length of a full cycle, X |
| `SEEN_DURATION_MS` | `900000` | length of the fame window, Y (≤ X) |
| `SEEN_PREP_GRACE_MS` | `180000` | time the chosen person has to submit |
| `SEEN_DEMO_MODE` | unset | `=1` seeds a fake visible demo reveal |
| `NEXT_PUBLIC_SEEN_DEBUG_PANEL` | unset | `=1` shows the floating debug panel |

Add `?debug` to the URL for the debug panel without env vars.
