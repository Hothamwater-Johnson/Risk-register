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
- **Paper trading** (2026-06-11, `src/lib/paper.ts`; reworked 2026-06-12):
  - Leg sides/prices stored in **venue-real terms**; `outcomeInverted`
    applied only at open/settle, never when valuing against a venue's own book.
  - Marked to market at the **bid minus estimated exit fees**, never mids.
  - Fills recomputed **server-side at submit** from latest snapshot
    (intentional glance-to-click slippage).
  - `expectedEdge` recorded at entry → **capture ratio** (realized/promised)
    on `/paper` is the calibration metric for the whole dashboard.
  - **Open is idempotent** (2026-06-12, after 5 accidental duplicate opens):
    server-minted UUID in the form + unique index `paper_trades_idem_uq`;
    retries return the original fill as a "duplicate" state, key rotates
    client-side after success. Actions return `useActionState` state, never
    throw for user errors (prod masks thrown server-action errors).
  - **Settlement is automatic** (hourly `settle-paper` job) when Kalshi
    reports status `finalized` + result `yes|no`; the Settled YES/NO buttons
    remain as the manual override (canonical = Kalshi question). Both paths
    share `settleOpenTrade()` with a `status='open'` guard (race-safe).
  - **Identities** (2026-06-12): owner = ADMIN_TOKEN cookie (`paper_token`),
    book at `profileId NULL`; testers = email + shared `INVITE_CODE` env var
    → row in `profiles`, HMAC-signed cookie `ss_profile` (key = ADMIN_TOKEN).
    No email verification by design — each profile gets its own
    `PAPER_STARTING_BANKROLL` (default $1,000) book. There is no separate
    login: the one form on /paper is sign-up AND sign-in (same email +
    invite code returns the existing book; cookie lives 1 year). Tester
    roster at `/admin/testers?token=…` (added 2026-06-12).
- **Jobs**: all under `/api/jobs/*`, bearer `CRON_SECRET`, wrapped by
  `runJob()` → `sync_runs` rows visible at `/admin/health`.
- **Auto-trader / paper bot** (2026-06-13→15, `src/lib/autoTrader.ts`, page
  `/admin/auto-trader`, hourly job `/api/jobs/auto-trade`): admin-only bot that
  auto-opens the same paper arbs a human would, under a dedicated **bot
  profile** with a per-bucket idempotency key
  (`botIdempotencyKey(linkId, bucketStartMs)`) so duplicate/concurrent runs are
  safe. Defaults: `MIN_EDGE` 0.02, `STAKE_USD` 100, `MAX_OPEN` 20.
  - **Password-gated** (`AUTO_TRADER_PASSWORD`, default `"hotham"` — set a real
    one in prod); ADMIN_TOKEN path also works. **One active session** at a time
    (`tradingSessions` table, `drizzle/0003`); start/stop + **Clear** (banks the
    run to CSV, `/admin/auto-trader/export`) + **Run now**; Last-run breakdown
    shows plain-English skip chips; cumulative report `/admin/auto-trader/report`.
  - **Holds arbs to settlement.** Mark-to-market TP/SL is OFF by default
    (`AUTO_TRADER_TAKE_PROFIT_USD` / `AUTO_TRADER_STOP_USD` = 0 = disabled) —
    directional risk controls on a *hedged* arb just realize the book's spread
    as a loss (errors.md #12). Only early exit kept: the rules-differ basis-risk
    exit (`AUTO_TRADER_CLOSE_RULES_DIFFER`). Normal exits via `settle-paper`.
  - **No re-entry within a session**: `tradedLinks` = every `marketLinkId` the
    bot touched this session (open OR closed); a traded link is skipped.
    `MAX_PER_PAIR` only bounded *concurrent* opens, which let it loop on a loser.
  - **Resolution-horizon gate** `AUTO_TRADER_MAX_DAYS_TO_RESOLVE` (default 90;
    **<= 0 disables**, via `horizonMs = null` — so `0` means *no limit*, NOT
    "zero days"): skip arbs resolving > N days out (they freeze capital and never
    inform the capture ratio in time). Close date =
    `kalshiEvent.closeTime ?? polymarketEvent.closeTime`. A **missing** close
    date and a **genuinely far** date are now distinct skip reasons —
    `skippedNoCloseDate` ("no close date") vs `skippedTooFar` ("resolves too far
    out") — so the breakdown says *why* nothing opened (2026-06-15).

## Production (2026-06-11)

- **Live at https://speedscout.vercel.app** — Vercel project `speed_scout`
  (id `prj_BS1RQPWUS0zAICyW7Athw2XmPMeh`), Hobby tier, owner's personal
  account. Production branch = repo default branch =
  `claude/prediction-market-dashboard-sflw0h` (there is NO `main`).
  Feature work lands on a session branch and is pushed to both.
  **Discrepancy to resolve (2026-06-15)**: owner stated Vercel builds Production
  from the active session branch `claude/paper-auto-trader-ph4kdv` (push = a
  Production deploy), which differs from the default branch above. Confirm
  Vercel Settings → Git → Production Branch before assuming either; when unsure,
  push to both.
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
  GitHub Actions repo secret. INVITE_CODE (2026-06-12) gates tester
  paper-trading sign-ups; unset = sign-ups disabled. SET and live as of
  2026-06-12 evening — testers are actively signing up; the value is in
  Vercel env only, never in this repo.

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
- **Kalshi settlement wire format** (verified live 2026-06-12,
  `scripts/check-kalshi-settlement.ts`): settled markets report status
  `finalized` + `result: "yes"|"no"` (500-sample had no other values);
  `status=closed` queries return the intermediate `determined` (result known
  but settlement timer running — do NOT settle on it); `?status=finalized`
  is a 400 (use `?status=settled`); `GET /markets?tickers=` DOES return
  settled tickers, which is what makes the settle-paper job possible
  (sync-catalog only ever sees open events).
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
