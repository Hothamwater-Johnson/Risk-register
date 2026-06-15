import { cookies } from "next/headers";
import { asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { feeCategoryFor } from "./arb/fees";
import {
  AUTO_TRADER_CLOSE_RULES_DIFFER,
  AUTO_TRADER_ENABLED,
  AUTO_TRADER_MAX_DAYS_TO_RESOLVE,
  AUTO_TRADER_MAX_OPEN,
  AUTO_TRADER_MIN_EDGE,
  AUTO_TRADER_PASSWORD,
  AUTO_TRADER_STAKE_USD,
  AUTO_TRADER_STOP_USD,
  AUTO_TRADER_TAKE_PROFIT_USD,
} from "./config";
import { db } from "./db/client";
import { paperTrades, tradingSessions, type TradingSession } from "./db/schema";
import {
  arbEntryCost,
  arbLegsFromResult,
  botIdempotencyKey,
  closeTradeAtMarket,
  ensureBotProfileId,
  getPaperTradeViews,
  hasPaperAccess,
  paperStats,
  type PaperStats,
  type PaperTradeView,
} from "./paper";
import { getActivePairs } from "./queries";

/**
 * Auto-trader session control. The bot's start/stop state and its trading
 * history live in `trading_sessions`: the single row with endedAt = null is the
 * active session, and its status ('running' | 'paused') is the start/stop
 * toggle the job reads. "Clear" finalizes that row (logs stats + a CSV
 * snapshot), wipes the bot's paper_trades back to a fresh bankroll, and opens a
 * new paused session. Every reader degrades gracefully if the table hasn't been
 * migrated yet (falls back to the AUTO_TRADER_ENABLED env flag).
 */

// Shared with the page's unlock/lock actions and the CSV export route.
export const AT_ACCESS_COOKIE = "at_access";
export const atCookieOpts = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 365,
} as const;

/** Page/route access: the simple password cookie OR the existing ADMIN_TOKEN paths. */
export async function hasAutoTraderAccess(token?: string): Promise<boolean> {
  if (await hasPaperAccess(token)) return true;
  const store = await cookies();
  return store.get(AT_ACCESS_COOKIE)?.value === AUTO_TRADER_PASSWORD;
}

/** True when the error is "trading_sessions table not migrated yet". */
function isMissingTable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /trading_sessions|relation .* does not exist|undefined_table|42P01/i.test(m);
}

export type AutoTraderState = {
  session: TradingSession | null;
  running: boolean;
  migrationNeeded: boolean;
};

export async function getAutoTraderState(): Promise<AutoTraderState> {
  try {
    const [session] = await db()
      .select()
      .from(tradingSessions)
      .where(isNull(tradingSessions.endedAt))
      .orderBy(desc(tradingSessions.startedAt))
      .limit(1);
    return {
      session: session ?? null,
      running: session?.status === "running",
      migrationNeeded: false,
    };
  } catch (err) {
    if (isMissingTable(err)) {
      return { session: null, running: AUTO_TRADER_ENABLED, migrationNeeded: true };
    }
    throw err;
  }
}

/** The auto-trade job runs only when the active session is 'running'. */
export async function isAutoTraderRunning(): Promise<boolean> {
  return (await getAutoTraderState()).running;
}

/**
 * One auto-trade pass (shared by the /api/jobs/auto-trade cron route and the
 * admin "Run now" button). On each run the bot:
 *  1. CLOSES open positions on take-profit / stop-loss (both opt-in, default
 *     off) or a positive mark on a rules-differ pair. A clean arb otherwise
 *     rides to settlement (settle-paper closes it).
 *  2. OPENS arbs whose after-fee netEdge clears AUTO_TRADER_MIN_EDGE and whose
 *     book isn't thin, sized so notional never exceeds executable depth or cash,
 *     and never re-entering a pair already traded this session.
 */
export async function autoTradeOnce(): Promise<Record<string, unknown>> {
  // Start/stop is the live control: only trade when the active session is
  // 'running'. (Falls back to AUTO_TRADER_ENABLED pre-migration.)
  if (!(await isAutoTraderRunning())) return { skipped: "paused or no active session" };

  const botProfileId = await ensureBotProfileId();
  const pairs = await getActivePairs(50);

  const rulesDifferByLink = new Map<string, boolean>();
  for (const pair of pairs) {
    for (const lv of pair.links) rulesDifferByLink.set(lv.link.id, pair.rulesDiffer);
  }

  // ---- Close pass first, so freed capital is reusable within this run. ----
  const closes = { take_profit: 0, stop_loss: 0, rules_differ: 0, stale: 0, already_closed: 0 };
  const openViews = (await getPaperTradeViews(botProfileId)).filter(
    (v) => v.trade.status === "open",
  );
  for (const v of openViews) {
    if (!v.link) continue;
    const pnl = v.mark.unrealizedPnlUsd;
    if (v.mark.stale || pnl === null) continue; // no quote to close against
    const rulesDiffer = rulesDifferByLink.get(v.link.id) ?? false;

    // TP/SL are opt-in (0 = disabled). For a hedged arb they're usually
    // value-destructive — a real arb pays $1 at settlement, so we hold by
    // default and let settle-paper close it. Only rules-differ basis risk is
    // banked early.
    let reason: "take_profit" | "stop_loss" | "rules_differ" | null = null;
    if (AUTO_TRADER_TAKE_PROFIT_USD > 0 && pnl >= AUTO_TRADER_TAKE_PROFIT_USD) {
      reason = "take_profit";
    } else if (AUTO_TRADER_STOP_USD > 0 && pnl <= -AUTO_TRADER_STOP_USD) {
      reason = "stop_loss";
    } else if (AUTO_TRADER_CLOSE_RULES_DIFFER && rulesDiffer && pnl > 0) {
      reason = "rules_differ";
    }
    if (!reason) continue;

    const res = await closeTradeAtMarket(v.trade, v.link, feeCategoryFor(v.event?.category), reason);
    if (res.ok) closes[reason]++;
    else closes[res.reason]++;
  }

  // ---- Open pass: re-read the book so cash & open counts reflect the closes. ----
  const views = await getPaperTradeViews(botProfileId);
  const stats = paperStats(views);
  let cashUsd = stats.cashUsd;
  let currentOpen = views.filter((v) => v.trade.status === "open").length;
  // No re-entry within a session: skip any link the bot already has ANY trade
  // on (open OR closed). Cleared sessions are deleted, so this set == the
  // current session. This kills the open→stop-out→re-open loss loop.
  const tradedLinks = new Set(views.map((v) => v.trade.marketLinkId));

  // Coarse hourly bucket: two runs in the same hour produce the same key per
  // link, so the unique index drops the second insert — race + rate guard.
  const bucketStartMs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const opens = {
    opened: 0,
    skippedNoArb: 0,
    skippedThin: 0,
    skippedBelowEdge: 0,
    skippedHasPosition: 0,
    skippedTooSmall: 0,
    skippedNoCash: 0,
    skippedDuplicate: 0,
    skippedNoCloseDate: 0,
    skippedTooFar: 0,
    hitMaxOpen: 0,
  };

  // Skip pairs that resolve too far out: a long-dated arb freezes capital until
  // settlement and never informs the capture ratio in time. A missing close date
  // (likely a perpetual/undated market, or a sync gap) is also skipped, but under
  // its own reason so the two cases stay distinguishable in the run breakdown.
  const horizonMs =
    AUTO_TRADER_MAX_DAYS_TO_RESOLVE > 0
      ? AUTO_TRADER_MAX_DAYS_TO_RESOLVE * 86_400_000
      : null;

  for (const pair of pairs) {
    if (horizonMs !== null) {
      const closeAt = pair.kalshiEvent.closeTime ?? pair.polymarketEvent.closeTime;
      if (!closeAt) {
        opens.skippedNoCloseDate += pair.links.length;
        continue;
      }
      if (closeAt.getTime() - Date.now() > horizonMs) {
        opens.skippedTooFar += pair.links.length;
        continue;
      }
    }
    for (const lv of pair.links) {
      if (currentOpen >= AUTO_TRADER_MAX_OPEN) {
        opens.hitMaxOpen++;
        continue;
      }
      const arb = lv.spread.arb;
      if (!arb) {
        opens.skippedNoArb++;
        continue;
      }
      if (arb.thinBook || arb.executableUsd === null) {
        opens.skippedThin++;
        continue;
      }
      if (arb.netEdge < AUTO_TRADER_MIN_EDGE) {
        opens.skippedBelowEdge++;
        continue;
      }
      if (tradedLinks.has(lv.link.id)) {
        opens.skippedHasPosition++; // already traded this session — no re-entry
        continue;
      }

      const feeCat = feeCategoryFor(pair.kalshiEvent.category);
      const legs = arbLegsFromResult(arb, lv.link.outcomeInverted);
      // priceWithFees ≈ USD outlay per share; never claim more than the book's
      // executable depth supports, nor more than free paper cash.
      const priceWithFees = arb.yesAsk + arb.noAsk + arb.feesPerShare;
      const budgetUsd = Math.min(AUTO_TRADER_STAKE_USD, cashUsd, arb.executableUsd);
      const shares = Math.floor(budgetUsd / priceWithFees);
      if (shares < 1) {
        opens.skippedTooSmall++;
        continue;
      }

      const { entryFeesUsd, costUsd } = arbEntryCost(legs, shares, feeCat);
      if (costUsd > cashUsd) {
        opens.skippedNoCash++;
        continue;
      }

      const inserted = await db()
        .insert(paperTrades)
        .values({
          marketLinkId: lv.link.id,
          profileId: botProfileId,
          idempotencyKey: botIdempotencyKey(lv.link.id, bucketStartMs),
          kalshiSide: legs.kalshiSide,
          kalshiEntry: legs.kalshiEntry,
          polySide: legs.polySide,
          polyEntry: legs.polyEntry,
          shares,
          entryFeesUsd,
          expectedEdge: legs.expectedEdge,
          entryDisagreement: lv.spread.disagreement,
          thinBookAtEntry: legs.thinBook,
          thesis: `auto: netEdge ${(arb.netEdge * 100).toFixed(2)}c, exec $${arb.executableUsd.toFixed(0)}`,
        })
        .onConflictDoNothing({ target: paperTrades.idempotencyKey })
        .returning();

      if (inserted.length === 0) {
        opens.skippedDuplicate++; // lost the bucket race — position already exists
        continue;
      }
      opens.opened++;
      currentOpen++;
      cashUsd -= costUsd;
      tradedLinks.add(lv.link.id);
    }
  }

  return { ...opens, closes, cashUsdAfter: Number(cashUsd.toFixed(2)) };
}

/** Get the active session, creating one (paused, or running if the env default
 * is on) if none exists. App-level "one active session" guarantee. */
async function ensureActiveSession(): Promise<TradingSession> {
  const [existing] = await db()
    .select()
    .from(tradingSessions)
    .where(isNull(tradingSessions.endedAt))
    .orderBy(desc(tradingSessions.startedAt))
    .limit(1);
  if (existing) return existing;
  const [created] = await db()
    .insert(tradingSessions)
    .values({ status: AUTO_TRADER_ENABLED ? "running" : "paused" })
    .returning();
  return created;
}

export async function startAutoTrader(): Promise<void> {
  const s = await ensureActiveSession();
  if (s.status !== "running") {
    await db()
      .update(tradingSessions)
      .set({ status: "running" })
      .where(eq(tradingSessions.id, s.id));
  }
}

export async function pauseAutoTrader(): Promise<void> {
  const [s] = await db()
    .select()
    .from(tradingSessions)
    .where(isNull(tradingSessions.endedAt))
    .limit(1);
  if (s && s.status !== "paused") {
    await db()
      .update(tradingSessions)
      .set({ status: "paused" })
      .where(eq(tradingSessions.id, s.id));
  }
}

export async function listArchivedSessions(limit = 25): Promise<TradingSession[]> {
  try {
    return await db()
      .select()
      .from(tradingSessions)
      .where(isNotNull(tradingSessions.endedAt))
      .orderBy(desc(tradingSessions.endedAt))
      .limit(limit);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

// ---- CSV (Excel / Google Sheets readable) ----

const CSV_HEADERS = [
  "trade_id",
  "status",
  "opened_at",
  "closed_at",
  "event_title",
  "kalshi_side",
  "kalshi_entry",
  "poly_side",
  "poly_entry",
  "shares",
  "cost_usd",
  "entry_fees_usd",
  "expected_edge",
  "entry_disagreement",
  "thin_book_at_entry",
  "exit_kalshi",
  "exit_poly",
  "exit_fees_usd",
  "realized_pnl_usd",
  "unrealized_pnl_usd",
  "close_reason",
  "thesis",
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const iso = (d: Date | null | undefined): string =>
  d ? new Date(d).toISOString() : "";

export function buildTradesCsv(views: PaperTradeView[]): string {
  const rows = views.map((v) => {
    const t = v.trade;
    return [
      t.id,
      t.status,
      iso(t.openedAt),
      iso(t.closedAt),
      v.event?.title ?? v.kalshiMarket?.question ?? "",
      t.kalshiSide ?? "",
      t.kalshiEntry ?? "",
      t.polySide ?? "",
      t.polyEntry ?? "",
      t.shares,
      v.costUsd,
      t.entryFeesUsd,
      t.expectedEdge ?? "",
      t.entryDisagreement ?? "",
      t.thinBookAtEntry,
      t.exitKalshi ?? "",
      t.exitPoly ?? "",
      t.exitFeesUsd ?? "",
      t.realizedPnlUsd ?? "",
      t.status === "open" ? (v.mark.unrealizedPnlUsd ?? "") : "",
      t.closeReason ?? "",
      t.thesis ?? "",
    ]
      .map(csvCell)
      .join(",");
  });
  // CRLF line endings: friendliest for Excel.
  return [CSV_HEADERS.join(","), ...rows].join("\r\n");
}

/** CSV for one session: the stored snapshot for an ended session, or a live
 * build from the bot's current trades for the active session / "current". */
export async function getSessionCsv(
  sessionId: string,
): Promise<{ csv: string; name: string } | null> {
  const live = async () => {
    const botProfileId = await ensureBotProfileId();
    return {
      csv: buildTradesCsv(await getPaperTradeViews(botProfileId)),
      name: "auto-trader-current",
    };
  };
  try {
    if (sessionId && sessionId !== "current") {
      const [s] = await db()
        .select()
        .from(tradingSessions)
        .where(eq(tradingSessions.id, sessionId))
        .limit(1);
      if (!s) return null;
      if (s.csv != null) {
        return {
          csv: s.csv,
          name: `auto-trader-session-${iso(s.startedAt).slice(0, 10)}-${s.id.slice(0, 8)}`,
        };
      }
    }
    return await live();
  } catch (err) {
    if (isMissingTable(err)) return await live();
    throw err;
  }
}

// ---- reporting (cumulative analysis across sessions) ----

type SessionStatsBlob = Partial<PaperStats> & {
  openAtClear?: number;
  closedAtClear?: number;
};

export type ReportPoint = {
  label: string; // session end date, or "active"
  active: boolean;
  realizedPnlUsd: number;
  cumulativePnlUsd: number; // running sum of realized across sessions
  captureRatio: number | null;
  expectedPnlUsd: number;
  equityUsd: number;
  tradeCount: number;
};

export type ReportData = {
  migrationNeeded: boolean;
  lifetime: {
    realizedPnlUsd: number;
    captureRatio: number | null;
    winRate: number | null;
    sessionsCleared: number;
    trades: number;
    currentEquityUsd: number;
  };
  series: ReportPoint[];
  closeReasons: { reason: string; count: number }[]; // current session
};

/** Aggregate every cleared session's stored summary + the live session into the
 * series and lifetime totals the Reporting view charts. */
export async function getReportData(): Promise<ReportData> {
  const botProfileId = await ensureBotProfileId();
  const views = await getPaperTradeViews(botProfileId);
  const live = paperStats(views);

  let archived: TradingSession[] = [];
  let migrationNeeded = false;
  try {
    archived = await db()
      .select()
      .from(tradingSessions)
      .where(isNotNull(tradingSessions.endedAt))
      .orderBy(asc(tradingSessions.endedAt))
      .limit(500);
  } catch (err) {
    if (isMissingTable(err)) migrationNeeded = true;
    else throw err;
  }

  type Row = {
    label: string;
    active: boolean;
    realized: number;
    capture: number | null;
    expected: number;
    equity: number;
    trades: number;
    winCount: number;
    closedCount: number;
  };
  const rows: Row[] = archived.map((s) => {
    const st = (s.stats ?? {}) as SessionStatsBlob;
    return {
      label: iso(s.endedAt).slice(0, 10),
      active: false,
      realized: st.realizedPnlUsd ?? 0,
      capture: st.captureRatio ?? null,
      expected: st.expectedPnlUsd ?? 0,
      equity: st.equityUsd ?? 0,
      trades: s.tradeCount ?? 0,
      winCount: st.winCount ?? 0,
      closedCount: st.closedCount ?? 0,
    };
  });
  rows.push({
    label: "active",
    active: true,
    realized: live.realizedPnlUsd,
    capture: live.captureRatio,
    expected: live.expectedPnlUsd,
    equity: live.equityUsd,
    trades: views.length,
    winCount: live.winCount,
    closedCount: live.closedCount,
  });

  let cumulative = 0;
  const series: ReportPoint[] = rows.map((r) => {
    cumulative += r.realized;
    return {
      label: r.label,
      active: r.active,
      realizedPnlUsd: r.realized,
      cumulativePnlUsd: cumulative,
      captureRatio: r.capture,
      expectedPnlUsd: r.expected,
      equityUsd: r.equity,
      tradeCount: r.trades,
    };
  });

  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const expectedTotal = sum((r) => r.expected);
  // realizedOnArbs per session = captureRatio × expectedPnl (captureRatio is
  // realizedOnArbs / expectedPnl), so lifetime capture re-aggregates correctly.
  const realizedOnArbsTotal = sum((r) => (r.capture != null ? r.capture * r.expected : 0));
  const closedTotal = sum((r) => r.closedCount);

  const reasonCounts = new Map<string, number>();
  for (const v of views) {
    if (v.trade.status === "closed" && v.trade.closeReason) {
      reasonCounts.set(v.trade.closeReason, (reasonCounts.get(v.trade.closeReason) ?? 0) + 1);
    }
  }

  return {
    migrationNeeded,
    lifetime: {
      realizedPnlUsd: sum((r) => r.realized),
      captureRatio: expectedTotal > 0 ? realizedOnArbsTotal / expectedTotal : null,
      winRate: closedTotal > 0 ? sum((r) => r.winCount) / closedTotal : null,
      sessionsCleared: archived.length,
      trades: sum((r) => r.trades),
      currentEquityUsd: live.equityUsd,
    },
    series,
    closeReasons: [...reasonCounts].map(([reason, count]) => ({ reason, count })),
  };
}

export type ClearResult =
  | { ok: true; archivedId: string; trades: number; closed: number }
  | { ok: false; migrationNeeded: true };

/**
 * End the active session: finalize open positions at market (so logged results
 * are final), snapshot stats + a per-trade CSV onto the session row, wipe the
 * bot's paper_trades back to a fresh bankroll, and open a new paused session.
 */
export async function clearSession(): Promise<ClearResult> {
  try {
    const botProfileId = await ensureBotProfileId();
    const session = await ensureActiveSession();

    const open = (await getPaperTradeViews(botProfileId)).filter(
      (v) => v.trade.status === "open",
    );
    let closed = 0;
    for (const v of open) {
      if (!v.link) continue;
      const res = await closeTradeAtMarket(v.trade, v.link, feeCategoryFor(v.event?.category));
      if (res.ok) closed++;
    }

    const views = await getPaperTradeViews(botProfileId);
    const stats = paperStats(views);

    await db()
      .update(tradingSessions)
      .set({
        endedAt: new Date(),
        status: "ended",
        tradeCount: views.length,
        stats: { ...stats, openAtClear: open.length, closedAtClear: closed },
        csv: buildTradesCsv(views),
      })
      .where(eq(tradingSessions.id, session.id));

    await db().delete(paperTrades).where(eq(paperTrades.profileId, botProfileId));

    await db().insert(tradingSessions).values({ status: "paused" });
    return { ok: true, archivedId: session.id, trades: views.length, closed };
  } catch (err) {
    if (isMissingTable(err)) return { ok: false, migrationNeeded: true };
    throw err;
  }
}
