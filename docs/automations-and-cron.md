# Automations, Flows & Broadcast cron

Three background jobs run on a schedule. They're plain HTTP endpoints —
something has to **ping them on an interval**. All three share one secret.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/automations/cron` | Drains automation **Wait** steps (resumes pending executions). |
| `GET /api/flows/cron` | Sweeps abandoned/stale flow runs (marks them `timed_out`). |
| `GET /api/broadcasts/cron` | Fires **scheduled broadcasts** when their time arrives. |

## Auth

Each request must carry the header `x-cron-secret: <AUTOMATION_CRON_SECRET>`.
- Missing/empty env → endpoint returns **503** (`cron not configured`).
- Wrong secret → **401** (timing-safe compare on the broadcast/flows routes).

Generate one secret for all three:

```bash
openssl rand -hex 32
```

Set it as `AUTOMATION_CRON_SECRET` in your environment (the bundled
`install.sh` generates it automatically).

## How it's scheduled (Docker)

The `docker-compose.yml` ships a lightweight **`cron` sidecar** that loops
**sequentially** (curl waits for each response, so ticks never overlap) and
pings all three endpoints over the compose-internal network (`app:3000` —
nothing is exposed to the internet):

```
every CRON_INTERVAL seconds (default 60):
  curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" http://app:3000/api/broadcasts/cron
  curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" http://app:3000/api/automations/cron
  curl -H "x-cron-secret: $AUTOMATION_CRON_SECRET" http://app:3000/api/flows/cron
```

Tune the cadence with `CRON_INTERVAL` (seconds) in `.env.local`. Lower =
tighter scheduling precision for broadcasts.

### Other hosts

If you don't use the sidecar (e.g. an always-on host), point any scheduler at
the same URLs with the secret header — Hostinger cron, GitHub Actions,
Vercel Cron, EasyCron, or Supabase `pg_cron` + `pg_net` hitting the public URL.

## Scheduled broadcasts — how the cron works

1. A scheduled broadcast is stored `status='scheduled'` with `scheduled_at`
   and its recipients pre-created as `status='pending'` (audience is snapshot
   at schedule time).
2. Each tick: the cron claims due broadcasts (`scheduled` + `scheduled_at<=now`)
   flipping them to `sending` (per-row lock), then **drains a bounded batch of
   pending recipients** per broadcast, capped globally per tick to stay under
   Meta's rate limit and avoid function timeouts.
3. Large broadcasts drain across multiple ticks (status stays `sending` until
   no `pending` remain, then finalizes `sent`/`failed`). The drain is
   idempotent — it only ever touches `pending` rows.

Tenant isolation: the engine loads each broadcast's `whatsapp_config` by its
own `account_id`, so a broadcast always sends through its own WhatsApp number.
