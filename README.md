# Spread Scout

One view of every prediction market: the same real-world events priced on
**Kalshi** and **Polymarket**, with the gaps surfaced and explained in plain
English. Built for people who want to *become* prediction market traders, not
just existing power users.

**V1 is a public tool** — no login. Mobile-first PWA, weekly email digest,
SaaS plumbing (auth/billing/alerts) comes later.

📖 **[Owner's manual](docs/MANUAL.md)** — setup, usage, the trading playbook
(tips, dos & don'ts), and the `/paper` simulator for testing the dashboard's
signals with virtual money before risking any real ones.

## How it works

```
Kalshi API ─┐                       ┌─ / (biggest gaps + movers)
            ├─ sync-catalog (1h) ──►│
Gamma API ──┘        │              ├─ /e/[pair] (both prices, history,
                     ▼              │   plain-English explainers, rules)
              Postgres (Neon)       ├─ /markets (browse/search)
                     ▲              ├─ /learn (glossary, SEO)
CLOB books ── snapshot (5-15m)      └─ /admin/* (review queue, job health)
                     ▲
              match (6h): fuzzy heuristics ──► Claude verification ──► review queue
```

- **Event matching** (the hard problem): token/entity heuristics with a hard
  veto on differing numeric thresholds ("BTC > 100k" ≠ "BTC > 110k"), then a
  batched Claude call that reads both resolution rule sets and maps outcomes
  (including inversions). High-confidence pairs auto-publish with an
  "auto-matched" badge; the rest land in `/admin/matches` for one-tap review.
- **Arb math**: never last-trade prices. Disagreement = mid vs mid; executable
  arb = both asks + per-platform fee models + order-book depth gate (thin
  books are flagged, not hyped).
- **Every number explained**: all copy lives in `src/lib/explain/copy.ts`,
  shared by the UI and the weekly digest.

## Setup

1. **Database**: create a free [Neon](https://neon.tech) Postgres, set
   `DATABASE_URL`, then `pnpm drizzle-kit migrate` (or `push` for dev).
2. **Env**: copy `.env.example` → `.env.local` and fill in `CRON_SECRET`,
   `ADMIN_TOKEN`, `ANTHROPIC_API_KEY` (matching), `INVITE_CODE` (tester
   sign-ups for paper trading), optionally Resend keys (digest).
3. **Run**: `pnpm install && pnpm dev`
4. **Deploy**: import the repo on Vercel, add the same env vars.
   - **Pro plan**: `vercel.json` crons just work.
   - **Hobby plan**: Vercel crons fire max once/day — add `APP_BASE_URL` and
     `CRON_SECRET` as GitHub repo secrets and the included
     `.github/workflows/cron.yml` pinger drives the jobs instead.

### First-run order

```bash
# 1. catalog (hundreds of events per platform)
curl -H "Authorization: Bearer $CRON_SECRET" $BASE/api/jobs/sync-catalog
# 2. snapshots (run a few times, 5 min apart, to accumulate history)
curl -H "Authorization: Bearer $CRON_SECRET" $BASE/api/jobs/snapshot
# 3. matching (needs ANTHROPIC_API_KEY)
curl -H "Authorization: Bearer $CRON_SECRET" $BASE/api/jobs/match
# then review: $BASE/admin/matches?token=$ADMIN_TOKEN
# job health:  $BASE/admin/health?token=$ADMIN_TOKEN
```

## ⚠️ Verify on day 1 (facts this code assumes but could not confirm)

Built against documented API shapes; the build environment could not reach
either API live. Before trusting the numbers:

1. **Kalshi base URL** — `api.elections.kalshi.com/trade-api/v2` is the widely
   used base; some 2026 docs cite `external-api.kalshi.com`. Override with
   `KALSHI_BASE_URL` if needed.
2. **Response field shapes** — zod schemas in `src/lib/kalshi/client.ts` and
   `src/lib/polymarket/*.ts` are lenient, but spot-check the first
   `sync-catalog` run against the live sites (5 tickers each).
3. **Fee coefficients** (`src/lib/arb/fees.ts`) — Kalshi's Feb 2026 schedule
   and Polymarket's April 2026 taker fees change; after-fee edges are only as
   good as these numbers.
4. **Rate limits** — jobs are designed for ≤5 req/s Kalshi and ≤1 req/s Gamma
   with backoff; confirm the public tiers if you crank `SNAPSHOT_TOP_N`.
5. **Platform ToS** on commercial redistribution of data (matters for the
   SaaS phase).

## Roadmap (phase 2+)

Auth (Clerk/Better Auth) + Stripe tiers → real-time alerts via a small
always-on WebSocket worker → personal P&L (read-only Kalshi keys, Polymarket
wallet address) → trader leaderboard (Polymarket on-chain) → sportsbooks via
The Odds API (the matching engine is source-agnostic by design).
