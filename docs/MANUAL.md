# Spread Scout — Owner's Manual

Everything you need to set up, run, and actually *use* Spread Scout: the
dashboard, the trading playbook, and the paper-trading simulator that tells
you whether any of it works before a dollar moves.

> **Nothing in this document is financial advice.** Prediction markets can
> lose you money quickly, platform availability varies by jurisdiction, and
> every fee/price figure in this app is an estimate built from public data.

---

## Contents

1. [What Spread Scout is](#1-what-spread-scout-is)
2. [Setup](#2-setup)
3. [Using the dashboard](#3-using-the-dashboard)
4. [Trading guide](#4-trading-guide)
5. [Paper trading simulator](#5-paper-trading-simulator)
6. [Tips & tricks](#6-tips--tricks)
7. [Dos and don'ts](#7-dos-and-donts)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. What Spread Scout is

Kalshi and Polymarket often price *the same real-world event* differently.
Spread Scout ingests both platforms' catalogs, matches up equivalent events
(fuzzy heuristics + a Claude pass that reads both resolution rule sets),
snapshots order books every 5–15 minutes, and surfaces two distinct signals:

| Signal | Definition | What it's for |
|---|---|---|
| **Disagreement** | \|Kalshi mid − Polymarket mid\| | Information. One crowd may know something — or the rules differ. |
| **Executable arb** | 1 − (YES ask + NO ask) − fees, gated by book depth | A theoretical locked-in profit if you take both sides *right now*. |

The distinction matters: disagreement is computed from mids (honest but not
tradeable), the arb from asks (what you'd actually pay). A big disagreement
with no arb means the gap lives inside the bid-ask spreads — interesting,
not money.

## 2. Setup

### 2.1 Prerequisites

- Node 20+, `pnpm`
- A free [Neon](https://neon.tech) Postgres database
- An Anthropic API key (event matching)
- Optional: Resend keys (weekly email digest), Vercel account (hosting)

### 2.2 Local

```bash
pnpm install
cp .env.example .env.local        # then fill in:
#   DATABASE_URL        — Neon connection string
#   CRON_SECRET         — any long random string; protects /api/jobs/*
#   ADMIN_TOKEN         — any long random string; unlocks /admin/* and /paper
#   ANTHROPIC_API_KEY   — for the matching job
#   PAPER_STARTING_BANKROLL — optional, default 1000 (USD, virtual)
pnpm drizzle-kit migrate          # create tables (or `push` for dev)
pnpm dev
```

### 2.3 First run — populate the database, in this order

```bash
BASE=http://localhost:3000
# 1. Pull both platforms' catalogs (hundreds of events each)
curl -H "Authorization: Bearer $CRON_SECRET" $BASE/api/jobs/sync-catalog
# 2. Snapshot order books — run 3–4 times, ~5 minutes apart, to build history
curl -H "Authorization: Bearer $CRON_SECRET" $BASE/api/jobs/snapshot
# 3. Match events across platforms (uses the Anthropic key)
curl -H "Authorization: Bearer $CRON_SECRET" $BASE/api/jobs/match
```

Then review what matched at `/admin/matches?token=$ADMIN_TOKEN` and check
job health at `/admin/health?token=$ADMIN_TOKEN`.

### 2.4 Deploy (Vercel)

Import the repo, add the same env vars. On the **Pro** plan the crons in
`vercel.json` run the jobs automatically. On **Hobby** (crons max once/day),
add `APP_BASE_URL` and `CRON_SECRET` as GitHub repo secrets — the included
`.github/workflows/cron.yml` pinger drives the jobs instead.

### 2.5 Day-1 verification (do not skip)

The app was built against documented API shapes without live access. Before
trusting any number:

1. **Spot-check 5 markets per platform** against kalshi.com / polymarket.com
   after the first `sync-catalog` + `snapshot`.
2. **Verify fee coefficients** in `src/lib/arb/fees.ts` against both
   platforms' current fee schedules — both changed fees in 2026.
3. **Kalshi base URL** — override with `KALSHI_BASE_URL` if catalog sync 404s.
4. Confirm rate limits before raising `SNAPSHOT_TOP_N` above 200.

## 3. Using the dashboard

### 3.1 Home (`/`)

Matched pairs sorted by disagreement, plus the biggest 24-hour movers.
Badges you'll see:

- **`N¢ gap`** — current mid-vs-mid disagreement (red ≥ 5¢, amber ≥ 2¢).
- **`+N¢ after fees`** (green) — an arb whose net edge survives estimated
  fees *and* the depth gate. The rare good stuff.
- **`thin book`** — a gap exists but less than `MIN_EXECUTABLE_USD`
  (default $50) can actually be filled. Signal, not trade.
- **`rules differ`** — the LLM flagged materially different resolution
  criteria. Read both rule sets before doing anything.

### 3.2 Event pages (`/e/...`)

The anatomy, top to bottom:

1. **Quote boxes** — each platform's mid, bid, and ask. The mid is the
   "probability"; the bid/ask are your actual exit/entry prices.
2. **Plain-English explainer** of the current disagreement.
3. **Paper trade widget** (only when unlocked — see §5).
4. **7-day chart** of both platforms' mids — watch how gaps open and close.
5. **All linked outcomes** for multi-outcome events (elections etc.).
6. **Resolution rules** side by side, with a warning banner when they
   differ. This section is the difference between arbitrage and gambling.

### 3.3 Admin

- `/admin/matches?token=…` — review queue for auto-matched pairs: confirm,
  reject, or invert an outcome mapping (YES here = NO there).
- `/admin/health?token=…` — recent job runs, durations, errors.
- `/admin/testers?token=…` — everyone who signed up for paper trading:
  join date, open/closed trade counts, realized P&L, equity, last activity.
  The owner's book (`profileId NULL`) is not a profile and doesn't appear.

Review the match queue every few days; bad matches are the #1 source of
fake gaps.

## 4. Trading guide

### 4.1 The two trades this dashboard suggests

**A. The arb (both sides).** Buy YES on one platform and NO on the other
for less than $1 combined; collect exactly $1 at settlement regardless of
outcome. This is the "locked-in gap" box on event pages. Profit is capped
at the net edge × shares; risk is operational (see checklist).

**B. The convergence trade (one side).** When platforms disagree, decide
which crowd is right and buy the cheap side. E.g. Kalshi says 62%,
Polymarket says 57% — if you believe Kalshi, buy YES on Polymarket and exit
when prices converge. This is a directional bet: you can be flat-out wrong.

### 4.2 Pre-trade checklist (run it every time)

1. **Read both resolution rule sets.** Different sources, deadlines, or
   thresholds mean you're trading two different questions. This is the most
   common way cross-platform traders lose.
2. **Check the `rules differ` and `auto-matched` badges.** Auto-matched
   pairs are high-confidence, not certain.
3. **Confirm the prices are fresh** — snapshots are 5–15 minutes old.
   Open both platforms and look at the live books before committing.
4. **Check depth.** The displayed edge is for the top of the book. If the
   thin-book flag is on, assume you can't fill meaningful size.
5. **Recompute fees yourself** for real size — the app's fee model is an
   estimate, and both platforms have revised fees before.
6. **Mind the timeline.** An arb locks your money until settlement. A 2¢
   edge on a market that settles next year is a terrible interest rate.

### 4.3 Executing a real arb, step by step

1. Fund both accounts *in advance* — moving money takes hours-to-days and
   gaps live for minutes.
2. Work out total cost: `(yesAsk + noAsk) × shares + fees both sides`.
3. **Leg in on the thinner book first.** If the second leg slips away
   you're left with a directional position; the deeper book is less likely
   to move while you complete it.
4. Use limit orders at the displayed ask, not market orders.
5. If the second leg gets away from you, decide *immediately*: pay up to
   complete the hedge, or close the first leg. Don't sit on an accidental
   one-sided bet hoping.
6. Record everything (the paper simulator works for this too — see §5).

### 4.4 Position sizing

- Never put more than a few percent of bankroll into one event, even an
  "arb" — rule mismatches turn riskless trades into total losses.
- Size to the *executable depth* shown, not your bankroll.
- For convergence trades, halve whatever size feels right. Disagreements
  can widen for weeks before they close.

## 5. Paper trading simulator

The simulator answers the only question that matters: **do the edges this
dashboard displays survive contact with reality?** It trades virtual money
against the same snapshots the dashboard shows, with the same fee model,
and keeps score against what was promised.

### 5.1 Unlock

Visit `/paper`. Two ways in, each with its own separate book:

- **Owner**: expand "Unlock with the admin token" and enter `ADMIN_TOKEN`
  once — stored as a cookie on that device.
- **Testers**: sign up with an email plus the shared `INVITE_CODE` you give
  them. No passwords and no verification emails — the email is just a label
  for their book, and re-entering it signs them back in from any device.
  Each profile gets its own virtual $1,000. Don't reuse an invite code you
  care about elsewhere, and rotate it (Vercel env var) to stop new sign-ups.

### 5.2 Open a trade

On any event page, the **"Paper trade this"** widget appears below the
price boxes once unlocked. Pick a mode:

- **Arb** — takes both legs of the currently displayed arb at the asks.
- **Buy YES/NO on Kalshi / Polymarket** — one-sided convergence bets, in
  terms of the Kalshi question (inverted Polymarket mappings are handled
  for you).

Enter share count and (optionally) your thesis — future-you reviewing the
history will want to know what past-you was thinking. Fills are computed
**server-side from the latest snapshot at the moment you submit**, so the
fill can differ from the label you clicked. That's intentional: it's the
same slippage a real order sees between glance and click.

The simulator enforces a cash limit (`PAPER_STARTING_BANKROLL`, default
$1,000) so position sizing stays honest.

### 5.3 Manage positions (`/paper`)

Each open trade is marked to market the honest way: legs valued at the
**bid** (what you could sell for now) minus estimated exit fees — never at
the mid. Actions per trade:

- **Close at market** — first tap previews what the current bids minus exit
  fees would net; the confirm tap sells (re-priced server-side at confirm).
  Use this for convergence trades when the gap closes.
- **Settled YES / Settled NO** — when the real-world event resolves, click
  the actual outcome (in terms of the Kalshi question). Winning legs pay
  $1, losing legs $0, no fees. Mostly a manual override now: the hourly
  `settle-paper` job auto-settles open trades when Kalshi reports the
  market **finalized** with a yes/no result (never on anything murkier).
- **Delete** — for misclicks; removes the trade from history entirely.

Each open position also has a "Both platforms since you entered" expander —
the same spread chart as the pair page, but windowed to your holding period.

### 5.4 Reading the scoreboard

- **Equity / Cash free / Open P&L / Realized P&L** — the basics.
- **"Is the dashboard honest?"** — the panel that matters. Every arb trade
  records the after-fee edge displayed at entry. The **capture ratio** is
  realized profit ÷ promised profit across closed arbs:
  - **≈ 100%** — displayed edges are real. The fee model and depth gate
    are well calibrated.
  - **Consistently < 80%** — the model is too optimistic. Tweak, in order
    of likelihood: fee coefficients in `src/lib/arb/fees.ts`, then raise
    `MIN_EXECUTABLE_USD`, then increase snapshot frequency in
    `vercel.json` (stale prices = phantom edges).
  - **> 100%** — you're closing convergence trades well, or settlement
    luck. Don't extrapolate from a small sample.

### 5.5 A suggested experiment protocol

1. For two weeks, paper-trade **every** non-thin-book arb the dashboard
   shows at a fixed 100 shares. No discretion — you're testing the tool,
   not yourself.
2. Separately, take convergence trades only when you have a reason
   (written in the thesis field).
3. After two weeks: if the arb capture ratio is healthy and the sample
   isn't tiny, the signal is real. If your convergence trades lose, the
   signal is fine but the discretion isn't — most people should only arb.
4. Re-run the experiment after any fee-model or threshold tweak.

### 5.6 Known limitations (read before celebrating)

- Fills assume the **top of the book at a 5–15 minute old snapshot**, with
  no size impact beyond the thin-book flag. Real fills are worse.
- No partial fills, no leg risk (paper arbs always get both sides — real
  ones sometimes don't), no funding friction, no platform outages.
- Auto-settlement trusts the **Kalshi** verdict for both legs (the canonical
  question). On a rules-differ pair the platforms can genuinely resolve
  differently — settle those manually with the real outcomes in mind.
- **Paper results are an upper bound.** Only take strategies live that
  look good with a wide margin.

## 6. Tips & tricks

- **The 7-day chart is the strategy.** Gaps that repeatedly open and close
  on the same pair are tradeable rhythms; gaps that sit frozen for a week
  usually mean a rules mismatch or a dead book.
- **Movers are leading indicators.** When one platform jumps on news, the
  other often lags by minutes-to-hours. The movers list on `/` shows you
  where to look.
- **Prices near 0¢ and 100¢ lie.** Longshot bias and capital lockup
  distort extreme prices; gaps there are rarely fillable profit.
- **Fees peak at 50/50.** Both platforms' taker fees scale with
  P×(1−P) — a 3¢ gross edge at 50¢ can be a 1¢ net edge; the same gap at
  85¢ keeps most of its value.
- **Maker beats taker.** Resting limit orders dodge most taker fees. The
  app prices everything as taker (worst case); patient real execution can
  beat the displayed net edge.
- **Use the thesis field religiously.** A month of annotated paper trades
  teaches you more about your own judgment than any backtest.
- **Watch `rules differ` pairs anyway.** They're not arbs, but they're
  free insight into how the two platforms' rulebooks diverge — knowledge
  that compounds.
- **Tune `MIN_EXECUTABLE_USD` to your real size.** If you'd trade $500 a
  leg, $50 of depth is noise; raise it and let the dashboard hide gaps you
  couldn't use anyway.

## 7. Dos and don'ts

**Do**

- ✅ Read both resolution rule sets before every trade. Every. Trade.
- ✅ Paper trade for at least two weeks before funding anything.
- ✅ Verify fee schedules and API field shapes on day 1 (§2.5).
- ✅ Pre-fund both platforms before you need them.
- ✅ Track expected vs realized on every trade — the capture ratio is the
  only score that matters.
- ✅ Treat thin-book gaps as information about where attention is, not as
  trades.
- ✅ Review the admin match queue regularly; bad matches create fake gaps.

**Don't**

- ❌ Don't trade a gap because it's big. Big gaps usually mean different
  questions, not free money.
- ❌ Don't use market orders to take both legs of an arb.
- ❌ Don't trust the displayed prices for execution — they're snapshots,
  minutes old. Confirm on the live books.
- ❌ Don't hold an accidental one-sided position after a failed second
  leg "until it comes back".
- ❌ Don't size convergence trades like arbs. One has a floor; the other
  goes to zero.
- ❌ Don't extrapolate from five paper trades. Capture ratios need a
  sample.
- ❌ Don't skip the jurisdiction check: confirm you can legally use each
  platform where you live before funding accounts.
- ❌ Don't forget opportunity cost — capital locked in a 2¢ edge until
  next year is capital not earning anywhere else.

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Home page empty | Jobs haven't run, or no matches confirmed yet. Run sync-catalog → snapshot → match (§2.3), then check `/admin/matches`. |
| `sync-catalog` 404s | Kalshi base URL changed — set `KALSHI_BASE_URL` (§2.5). |
| Prices look wrong vs the live sites | Snapshot staleness (check `/admin/health` for last run), or a zod field-shape mismatch — spot-check `src/lib/kalshi/client.ts` / `src/lib/polymarket/*.ts` against live responses. |
| "No current bid to close against" on `/paper` | The market stopped being snapshotted (closed, or fell out of the top-N). Run the snapshot job, or settle the trade manually with the real outcome. |
| Paper widget missing from event pages | Unlock at `/paper` first (sets the cookie), and note it only renders when at least one ask is quoted. |
| Capture ratio terrible | See §5.4 — fees, depth gate, snapshot cadence, in that order. |
| Match job produces junk pairs | Lower-confidence auto-publish: raise `MATCH_AUTO_CONFIRM` thresholds in `src/lib/config.ts` and lean on manual review. |

---

*Spread Scout shows public prices with estimated fees. Markets move fast,
displayed prices can be stale, and paper profits are not real profits.*
