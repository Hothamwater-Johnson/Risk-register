# memory.md — durable decisions & facts

Standing context for anyone (human or agent) working on this repo.
Update when decisions change; date entries when added.

## Product decisions (locked, user-confirmed)

- **V1 hook**: cross-market aggregation — same event priced on Kalshi vs
  Polymarket, gaps surfaced and explained in plain English. Built for people
  *becoming* traders, not power users. Owner uses it personally first, SaaS later.
- **Stack**: Next.js 16 (App Router) + Neon Postgres + Drizzle, Vercel,
  mobile-first PWA (owner works from a phone — design at 390px).
- **No auth/billing in V1**; public dashboard + email digest capture.
  Phase 2: auth, Stripe, real-time alerts, P&L tracking, sportsbooks.
- **Every number gets plain-English copy** from `src/lib/explain/copy.ts`
  (single source, shared by UI + digest). This is the differentiator.

## Engineering decisions

- **Prices are probabilities in [0,1] everywhere** (Kalshi cents ÷ 100 at ingest).
- **Arb math** (`src/lib/arb/`): never last-trade prices. Disagreement =
  |mid − mid|; executable arb = both asks + fee models + depth gate
  (`MIN_EXECUTABLE_USD`, default $50 → "thin book" flag). Fees shown
  before AND after, because coefficients are config, not truth.
- **Matching**: heuristics (hard veto on differing numeric thresholds) →
  batched Claude verification → auto-confirm at llm ≥ 0.9 + heuristic ≥ 0.7,
  else `/admin/matches` review queue. Manual decisions are terminal.
- **Paper trading** (2026-06-11, `src/lib/paper.ts`):
  - Leg sides/prices stored in **venue-real terms**; `outcomeInverted`
    applied only at open/settle, never when valuing against a venue's own book.
  - Marked to market at the **bid minus estimated exit fees**, never mids.
  - Fills recomputed **server-side at submit** from latest snapshot
    (intentional glance-to-click slippage).
  - `expectedEdge` recorded at entry → **capture ratio** (realized/promised)
    on `/paper` is the calibration metric for the whole dashboard.
  - Settlement is **manual** (Settled YES/NO buttons, canonical = Kalshi
    question). Auto-settlement from catalog sync is a known future task.
  - Gated by ADMIN_TOKEN via httpOnly cookie (`paper_token`); virtual
    bankroll `PAPER_STARTING_BANKROLL` (default $1,000).
- **Jobs**: all under `/api/jobs/*`, bearer `CRON_SECRET`, wrapped by
  `runJob()` → `sync_runs` rows visible at `/admin/health`.

## Infrastructure facts

- **Neon**: project `muddy-night-82322529`, db `neondb`, pooler host
  `ep-lingering-haze-apf99tun-pooler.c-7.us-east-1.aws.neon.tech`.
  Migrated through `0001` on 2026-06-11.
- **Secrets** (DATABASE_URL, CRON_SECRET, ADMIN_TOKEN): stored in the
  Claude Code environment's env vars (added 2026-06-11) and in `.env.local`
  locally. **Never commit values to this repo.**
- **ANTHROPIC_API_KEY**: not yet provisioned. Match job is blocked on it.
- **Cloud sessions**: environment network access set to **Full**
  (2026-06-11). Policy changes apply only to sessions started afterward.
  From cloud containers: outbound TCP (psql, port 5432) is blocked — use
  the Neon HTTP driver. `drizzle-kit migrate` doesn't read `.env.local`
  and hangs with neon-http; apply migration SQL via a script using
  `@neondatabase/serverless` `sql.unsafe()` per statement
  (split on `--> statement-breakpoint`).
- **AGENTS.md rule**: this Next.js version has breaking changes — read
  `node_modules/next/dist/docs/` before writing framework-touching code.

## Unverified assumptions (manual §2.5 — check on first real data)

- Kalshi base URL (`api.elections.kalshi.com/trade-api/v2`) vs newer docs.
- Fee coefficients in `src/lib/arb/fees.ts` (both platforms revised in 2026).
- zod response shapes for both APIs (built from docs, never seen live data).
- Rate limits (designed for ≤5 req/s Kalshi, ≤1 req/s Gamma).
