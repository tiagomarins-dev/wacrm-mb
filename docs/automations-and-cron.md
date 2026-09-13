# Automations, Flows & Broadcast cron

Three background jobs run on a schedule. They're plain HTTP endpoints —
something has to **ping them on an interval**. All three share one secret.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/automations/cron` | Drains automation **Wait** steps (resumes pending executions). |
| `GET /api/flows/cron` | Sweeps abandoned/stale flow runs (marks them `timed_out`). |
| `GET /api/broadcasts/cron` | Fires **scheduled broadcasts** when their time arrives. |
| `GET /api/mb-sync/cron` | Every `MB_SYNC_INTERVAL` (3600s): syncs **MB class tags** with the active students of the MB Platform API (`mb_class_sync`). `?dry=1` simulates without writing. |

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

## MB classes → tags (`/api/mb-sync/cron`)

Admins map **MB Platform course → CRM tag** in Settings → Turmas MB (by course
ID). Every hour the cron calls the platform API `curso.alunos.php` once per
mapped course — same key as the "Info Aluno" API, and the same 60 calls/hour
per IP quota — and makes each mapped tag hold exactly the matching contacts on
the Support connection. The tag belongs to the sync: members added by hand, on
any connection, are removed on the next run.

Every run is logged per tag in `mb_class_sync_runs`. A non-null
`aborted_reason` means nothing was written:

| Reason | Meaning |
|--------|---------|
| `no_eligible_students` | The courses returned no eligible student (e.g. course closed on the platform). The tag stays frozen — remove the pair in the UI. |
| `drop_over_50pct` | Fewer than half the students of the last applied run with the same courses (base ≥ 20). Protects against bad source data. |
| `tag_account_mismatch` | The pair points to a tag from another account. |
| `support_*` | `SUPPORT_CONNECTION_ID` missing, from another account or archived. |
| `api_unconfigured` | No platform API key (Settings → Integrations or `API_ALUNO_KEY`). |
| `api_<code>` | The API failed for one of the tag's courses (`api_rate_limited`, `api_unauthorized`, `api_timeout`, `api_http_500`…). Retried on the next run. |
| `course_not_found` | A mapped course ID no longer exists on the platform. |

Check recent runs:

```sql
select * from mb_class_sync_runs where tag_id = '<tag>' order by ran_at desc limit 5;
```

To accept a legitimate drop with the same courses (e.g. mass cancellation),
record a new baseline and let the next run apply:

```sql
insert into mb_class_sync_runs (account_id, tag_id, course_ids, students)
values ('<account>', '<tag>', '{90}', <expected new total>);
```
