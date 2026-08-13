# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Repo context

Fork of [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm) customized for the Milla Borges operation (wacrm-mb). Branch `producao` is what runs in production (a remote self-hosted Docker install); `main` tracks upstream and is the PR base. Supabase migrations are sometimes applied to the production database ahead of the code deploy — check before assuming schema and code are in lockstep.

## Commands

```bash
npm run dev          # dev server on :3000
npm run build        # production build (CI runs this)
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest run (all unit tests)
npx vitest run src/lib/whatsapp/inbound.test.ts   # single test file
npm run test:e2e     # Playwright, chromium project (excludes @real-evolution tags)
npm run test:e2e:evolution   # only @real-evolution tests (needs Evolution container)
npm run format       # prettier --write
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build. Playwright does NOT run in CI.

E2E notes: `playwright.config.ts` builds and starts the app itself (`npm run build && npm run start`), runs serially (`workers: 1`) against a test Supabase, and logs in once via the `setup` project saving `e2e/.auth/user.json`. Override the server with `E2E_WEBSERVER_CMD` / `E2E_BASE_URL`.

Self-host/deploy: `./install.sh` (interactive Docker installer; `--rebuild` after pulling code). It applies migrations, writes `.env.local`, and brings up `docker-compose.yml` (app + cron sidecar).

## Architecture

Next.js 16 App Router + React 19 + TypeScript + Tailwind v4, on Supabase (Postgres + Auth + Storage). Path alias `@/*` → `src/*`.

**Layering.** Business logic lives in `src/lib/<domain>/` as small pure-ish modules with colocated `*.test.ts` (Vitest, node env; MSW is started for every test by `src/test/setup.ts`, so network calls are mocked, never real). API routes in `src/app/api/<domain>/` are thin orchestrators over those libs. UI pages in `src/app/(dashboard)/<module>/` with components in `src/components/<module>/`.

**Multi-tenancy.** Everything is scoped by `account_id` with RLS on every table; roles are owner / admin / agent / viewer (`src/lib/auth/roles.ts`). Server-side code that must cross RLS uses the service-role admin client (`SUPABASE_SERVICE_ROLE_KEY`); browser/SSR clients come from `src/lib/supabase/client.ts` / `server.ts`. `src/middleware.ts` handles session refresh and auth redirects.

**WhatsApp provider abstraction.** `src/lib/providers/` defines a `MessageProvider` interface with two adapters: `meta-adapter.ts` (official Meta Cloud API, wraps `src/lib/whatsapp/meta-api.ts`) and `evolution-adapter.ts` (Evolution API, unofficial). `factory.ts` picks the adapter from `whatsapp_config.provider`; each provider declares capabilities (mass broadcast = Meta only, groups = Evolution only). An account can have multiple connections (numbers), each a `whatsapp_config` row with its own templates, business hours, and routing. Access tokens are AES-256-GCM encrypted at rest (`src/lib/whatsapp/encryption.ts`, `ENCRYPTION_KEY`).

**Inbound pipeline** — the heart of the system. `src/app/api/whatsapp/webhook/route.ts` receives Meta webhooks (HMAC-verified via `META_APP_SECRET`), persists contact/conversation/message, then fans out to the dispatchers: automations (`src/lib/automations/engine.ts`), flows (`src/lib/flows/engine.ts`), AI agent (`src/lib/ai-agent/dispatch.ts`, debounced so a burst of messages gets one reply), audio transcription (`src/lib/transcription/`), and broadcast-reply agent assignment. Evolution inbound arrives at `src/app/api/whatsapp/evolution/` and is normalized by `src/lib/providers/evolution-inbound.ts` into the same pipeline.

**Cron.** Three HTTP endpoints must be pinged on an interval (Docker cron sidecar does this): `/api/automations/cron` (drains Wait steps), `/api/flows/cron` (times out stale runs), `/api/broadcasts/cron` (fires scheduled broadcasts in bounded, idempotent batches). All share the `x-cron-secret: $AUTOMATION_CRON_SECRET` header. Details in `docs/automations-and-cron.md`.

**AI agent.** `src/lib/ai-agent/` — `engine.ts` builds the reply, `guardrail.ts` gates it, `prompt.ts`/`knowledge.ts` assemble context, per-agent profiles + number allow-list live in DB. LLM calls go through OpenRouter with a per-account token stored in Settings → Integrations (`integrations_config`), not env.

**Migrations.** `supabase/migrations/NNN_description.sql`, strictly sequential numbering — new migrations take the next number. Applied by `install.sh` or manually with psql; there is no ORM, types are hand-maintained in `src/types/`.

**i18n.** react-i18next with dictionaries in `src/messages/{en,pt-BR}/`; helpers in `src/lib/i18n/`. New UI strings must be added to both locales (pt-BR is the primary locale in production).

## Conventions

- Code comments are written in **Brazilian Portuguese**, placed before functions/blocks, explaining intent — follow the existing style (see `src/lib/providers/factory.ts` for the register).
- Comments describe how the system works now, never bug history, ticket numbers, or before/after narratives.
- Every non-trivial `src/lib` module gets a colocated `*.test.ts`; tests never hit real services (MSW + dummy `ENCRYPTION_KEY`/`META_APP_SECRET` from `vitest.config.ts`).
- shadcn/ui-style components live in `src/components/ui/`; module components go in `src/components/<module>/`.
