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

## Production (2026-06-11)

- **Live at https://speedscout.vercel.app** — Vercel project `speed_scout`
  (id `prj_BS1RQPWUS0zAICyW7Athw2XmPMeh`), Hobby tier, owner's personal
  account. Production branch = repo default branch =
  `claude/prediction-market-dashboard-sflw0h` (there is NO `main`).
  Feature work lands on a session branch and is pushed to both.
- **Deploying**: push to the production branch (webhook) or POST the
  project's deploy hook URL (Settings → Git → Deploy Hooks). CLI
  (`vercel deploy`) uploads get state BLOCKED on this account — avoid.
- **Hobby tier rejects sub-daily crons in vercel.json** (whole deploy
  fails). vercel.json crons are daily backstops; the real schedule is
  the GH Actions `cron-pinger` (10-min snapshots, hourly catalog, 6-h
  match). It needs one repo secret, CRON_SECRET; APP_BASE_URL is
  hardcoded with a secret override; it no-ops cleanly if unset.
- **Secrets**: DATABASE_URL, CRON_SECRET, ADMIN_TOKEN, ANTHROPIC_API_KEY
  in Vercel project env (set via API after a hand-typed first attempt
  was mistyped — when a credential mismatch appears, overwrite via API
  and redeploy; env vars bake in at deploy time). CRON_SECRET also a
  GitHub Actions repo secret.

## Cross-platform data gotchas (hard-won, do not regress)

- **Volume units are incomparable**: Polymarket `volume24h` is USD;
  Kalshi `volume_24h_fp` is contract counts. Never sort or threshold
  across platforms on volume. /markets ranks per platform and
  interleaves.
- **Postgres `DESC` sorts NULLs first** and ~10k markets have NULL
  volume: every volume ordering must be `DESC NULLS LAST` (markets page,
  snapshot top-N, match-job event selection — all fixed 2026-06-11).
- **Paper login** trims the pasted token (phone pastes carry trailing
  whitespace) and redirects to `/paper?denied=1` on mismatch.

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

## Verified against live data (2026-06-11, second session)

- **Kalshi base URL works** (`api.elections.kalshi.com/trade-api/v2`).
- **Kalshi wire format changed vs training-era docs**: prices are decimal
  STRINGS in dollars suffixed `_dollars` (dollars in [0,1] == probability),
  counts are strings suffixed `_fp`; integer-cent fields are gone. Orderbook
  is `{orderbook_fp: {yes_dollars, no_dollars}}` with [priceStr, sizeStr]
  levels; candlesticks use `close_dollars` etc. Client normalizes all of it
  to `number|null` at parse time (`src/lib/kalshi/client.ts`); `centsToProb`
  removed. Markets have no `category`/`subtitle` fields (event has category).
- **Fees verified**: Kalshi series API exposes `fee_type`/`fee_multiplier`;
  every sampled category (incl. Crypto) is `quadratic` × 1 → 0.07 uniform.
  Polymarket charges taker fees ONLY on sports (0.03, buys only — sells
  exempt); geopolitics and all other categories currently fee-free.
  `fees.ts` updated; re-verify periodically ("future expansions" announced).
- **zod shapes for Gamma + CLOB held against live data** (validation
  harness: `scripts/validate-live-apis.ts`, run with `pnpm dlx tsx`).

## Remaining unverified assumptions

- Rate limits (designed for ≤5 req/s Kalshi, ≤1 req/s Gamma).
- Kalshi sports-series maker fees are not modeled (we always price as taker).
