import { cookies } from "next/headers";
import { asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { feeCategoryFor } from "./arb/fees";
import { AUTO_TRADER_ENABLED, AUTO_TRADER_PASSWORD } from "./config";
import { db } from "./db/client";
import { paperTrades, tradingSessions, type TradingSession } from "./db/schema";
import {
  closeTradeAtMarket,
  ensureBotProfileId,
  getPaperTradeViews,
  hasPaperAccess,
  paperStats,
  type PaperStats,
  type PaperTradeView,
} from "./paper";

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
