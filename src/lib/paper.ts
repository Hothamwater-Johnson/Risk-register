import { createHash } from "crypto";
import { cookies } from "next/headers";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { ArbResult } from "./arb/spread";
import {
  feeCategoryFor,
  kalshiTakerFeePerShare,
  polymarketTakerFeePerShare,
  type FeeCategory,
} from "./arb/fees";
import { isAdmin } from "./config";
import { db } from "./db/client";
import {
  events,
  marketLinks,
  markets,
  paperTrades,
  profiles,
  type Event,
  type Market,
  type MarketLink,
  type PaperSide,
  type PaperTrade,
  type PriceSnapshot,
} from "./db/schema";
import { latestSnapshots } from "./queries";

/**
 * Paper-trading core: virtual fills against our own snapshots, valued at what
 * you could actually do right now (sell at the bid), never at mids. The point
 * is to measure whether the edges the dashboard displays survive contact with
 * reality — every trade stores the expected edge at entry so /paper can show
 * expected vs realized.
 */

export { PAPER_COOKIE } from "./profile";
import { PAPER_COOKIE as PAPER_COOKIE_NAME } from "./profile";

export const PAPER_STARTING_BANKROLL = Number(
  process.env.PAPER_STARTING_BANKROLL ?? 1000,
);

/** Admin (owner) access: ADMIN_TOKEN via cookie or explicit token. */
export async function hasPaperAccess(token?: string | null): Promise<boolean> {
  if (isAdmin(token)) return true;
  const store = await cookies();
  return isAdmin(store.get(PAPER_COOKIE_NAME)?.value);
}

/**
 * The auto-trader's book is a reserved profile, not the owner's NULL book, so
 * the bot's cash/equity/capture-ratio never commingle with manual owner trades
 * (paperStats is computed per profileId). The reserved email can't collide with
 * a tester sign-up — testers use real emails behind the invite code.
 */
export const BOT_PROFILE_EMAIL = "auto-trader@bot.spread-scout.internal";
export const BOT_PROFILE_DISPLAY_NAME = "Auto-trader (bot)";

/** Idempotently ensure the bot's reserved profile row exists; returns its id. */
export async function ensureBotProfileId(): Promise<string> {
  const [p] = await db()
    .insert(profiles)
    .values({ email: BOT_PROFILE_EMAIL, displayName: BOT_PROFILE_DISPLAY_NAME })
    // No-op update so RETURNING yields the existing row on every run after the
    // first; the unique email makes this safe under concurrent job runs.
    .onConflictDoUpdate({ target: profiles.email, set: { email: BOT_PROFILE_EMAIL } })
    .returning();
  return p.id;
}

/** Cost basis of one trade in USD, entry fees included. */
export function tradeCostUsd(t: PaperTrade): number {
  const perShare = (t.kalshiEntry ?? 0) + (t.polyEntry ?? 0);
  return perShare * t.shares + t.entryFeesUsd;
}

export type ArbLegs = {
  kalshiSide: PaperSide;
  kalshiEntry: number;
  polySide: PaperSide;
  polyEntry: number;
  expectedEdge: number;
  thinBook: boolean;
};

/**
 * Map a positive ArbResult onto venue-term legs, applying outcomeInverted, so
 * the manual open action and the auto-trader build identical positions.
 * Sides are stored in each venue's own terms; `flip` maps the canonical
 * (Kalshi-question) side onto the real Polymarket book when inverted.
 */
export function arbLegsFromResult(arb: ArbResult, outcomeInverted: boolean): ArbLegs {
  const flip = (s: PaperSide): PaperSide =>
    outcomeInverted ? (s === "yes" ? "no" : "yes") : s;
  if (arb.direction === "yes_kalshi") {
    return {
      kalshiSide: "yes",
      kalshiEntry: arb.yesAsk,
      polySide: flip("no"),
      polyEntry: arb.noAsk,
      expectedEdge: arb.netEdge,
      thinBook: arb.thinBook,
    };
  }
  return {
    kalshiSide: "no",
    kalshiEntry: arb.noAsk,
    polySide: flip("yes"),
    polyEntry: arb.yesAsk,
    expectedEdge: arb.netEdge,
    thinBook: arb.thinBook,
  };
}

/** Entry fees + total cost basis for a fully two-legged arb position. */
export function arbEntryCost(
  legs: Pick<ArbLegs, "kalshiEntry" | "polyEntry">,
  shares: number,
  feeCat: FeeCategory,
): { entryFeesUsd: number; costUsd: number } {
  const entryFeesUsd =
    kalshiTakerFeePerShare(legs.kalshiEntry, feeCat) * shares +
    polymarketTakerFeePerShare(legs.polyEntry, feeCat) * shares;
  return {
    entryFeesUsd,
    costUsd: (legs.kalshiEntry + legs.polyEntry) * shares + entryFeesUsd,
  };
}

/**
 * Deterministic (v5-shaped) UUID so two overlapping auto-trade runs in the same
 * time bucket generate the SAME idempotency_key for a link — the unique index
 * then makes the second insert a no-op. No `uuid` package is installed; the
 * sha1 of a namespaced string, reshaped to the RFC-4122 v5 layout, is enough
 * (we only need determinism + uniqueness, not cryptographic v5 semantics).
 */
export function botIdempotencyKey(linkId: string, bucketStartMs: number): string {
  const h = createHash("sha1")
    .update(`auto-trade:${linkId}:${bucketStartMs}`)
    .digest("hex");
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, "0");
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-` +
    `${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`
  );
}

/** What a leg could be sold for right now: its own venue's bid for that side. */
export function legBid(
  side: PaperSide | null,
  snap: PriceSnapshot | null,
): number | null {
  if (!side || !snap) return null;
  return side === "yes" ? snap.yesBid : snap.noBid;
}

export type TradeMark = {
  /** USD if both legs were sold at current bids, minus estimated exit fees. */
  valueUsd: number | null;
  unrealizedPnlUsd: number | null;
  /** Per-leg bids and fees behind valueUsd, for the close-at-market preview. */
  kalshiBid: number | null;
  polyBid: number | null;
  exitFeesUsd: number | null;
  /** True when any open leg has no current quote to mark against. */
  stale: boolean;
};

const EMPTY_MARK: TradeMark = {
  valueUsd: null,
  unrealizedPnlUsd: null,
  kalshiBid: null,
  polyBid: null,
  exitFeesUsd: null,
  stale: false,
};

export function markToMarket(
  t: PaperTrade,
  kalshiSnap: PriceSnapshot | null,
  polySnap: PriceSnapshot | null,
  feeCat: FeeCategory,
): TradeMark {
  if (t.status !== "open") return EMPTY_MARK;
  let perShare = 0;
  let exitFees = 0;
  let stale = false;
  let kalshiBid: number | null = null;
  let polyBid: number | null = null;

  if (t.kalshiSide) {
    kalshiBid = legBid(t.kalshiSide, kalshiSnap);
    if (kalshiBid === null) stale = true;
    else {
      perShare += kalshiBid;
      exitFees += kalshiTakerFeePerShare(kalshiBid, feeCat) * t.shares;
    }
  }
  if (t.polySide) {
    polyBid = legBid(t.polySide, polySnap);
    if (polyBid === null) stale = true;
    else {
      perShare += polyBid;
      exitFees += polymarketTakerFeePerShare(polyBid, feeCat, { isSell: true }) * t.shares;
    }
  }
  if (stale) return { ...EMPTY_MARK, kalshiBid, polyBid, stale };

  const valueUsd = perShare * t.shares - exitFees;
  return {
    valueUsd,
    unrealizedPnlUsd: valueUsd - tradeCostUsd(t),
    kalshiBid,
    polyBid,
    exitFeesUsd: exitFees,
    stale,
  };
}

/**
 * Settlement payout per share once the canonical (Kalshi-question) outcome is
 * known. The Polymarket leg flips through `outcomeInverted`. No exit fees:
 * settlement is not a trade.
 */
export function settlementValuePerShare(
  t: PaperTrade,
  kalshiYesWon: boolean,
  outcomeInverted: boolean,
): { kalshi: number | null; poly: number | null } {
  const polyYesWon = outcomeInverted ? !kalshiYesWon : kalshiYesWon;
  return {
    kalshi: t.kalshiSide
      ? (t.kalshiSide === "yes") === kalshiYesWon
        ? 1
        : 0
      : null,
    poly: t.polySide ? ((t.polySide === "yes") === polyYesWon ? 1 : 0) : null,
  };
}

/**
 * Close one open trade at the settled outcome. Shared by the manual Settled
 * YES/NO buttons and the settle-paper job; the `status = 'open'` guard makes
 * the two paths race-safe (whoever lands second is a no-op). Returns false
 * when the trade was already closed.
 */
export async function settleOpenTrade(
  trade: PaperTrade,
  outcomeInverted: boolean,
  kalshiYesWon: boolean,
): Promise<boolean> {
  const v = settlementValuePerShare(trade, kalshiYesWon, outcomeInverted);
  const payout = ((v.kalshi ?? 0) + (v.poly ?? 0)) * trade.shares;
  const updated = await db()
    .update(paperTrades)
    .set({
      status: "closed",
      closedAt: new Date(),
      exitKalshi: v.kalshi,
      exitPoly: v.poly,
      exitFeesUsd: 0,
      realizedPnlUsd: payout - tradeCostUsd(trade),
      closeReason: kalshiYesWon ? "settled_yes" : "settled_no",
    })
    .where(and(eq(paperTrades.id, trade.id), eq(paperTrades.status, "open")))
    .returning({ id: paperTrades.id });
  return updated.length > 0;
}

export type CloseAtMarketResult =
  | { ok: true }
  | { ok: false; reason: "stale" | "already_closed" };

/**
 * Close one open trade at the current market: each leg is sold at its own
 * venue's bid, minus taker exit fees (Polymarket sells are fee-exempt). Shared
 * by the manual "close at market" button and the auto-trader's close pass; the
 * `status = 'open'` guard makes both paths race-safe with each other and with
 * settlement. Returns `stale` when an open leg has no bid to close against —
 * the caller decides whether that's an error (manual) or a skip (bot).
 */
export async function closeTradeAtMarket(
  trade: PaperTrade,
  link: MarketLink,
  feeCat: FeeCategory,
): Promise<CloseAtMarketResult> {
  const snaps = await latestSnapshots([link.kalshiMarketId, link.polymarketMarketId]);
  const ks = snaps.get(link.kalshiMarketId) ?? null;
  const ps = snaps.get(link.polymarketMarketId) ?? null;

  const exitKalshi = trade.kalshiSide ? legBid(trade.kalshiSide, ks) : null;
  const exitPoly = trade.polySide ? legBid(trade.polySide, ps) : null;
  if ((trade.kalshiSide && exitKalshi === null) || (trade.polySide && exitPoly === null)) {
    return { ok: false, reason: "stale" };
  }

  const exitFeesUsd =
    (exitKalshi !== null ? kalshiTakerFeePerShare(exitKalshi, feeCat) * trade.shares : 0) +
    (exitPoly !== null
      ? polymarketTakerFeePerShare(exitPoly, feeCat, { isSell: true }) * trade.shares
      : 0);
  const proceeds = ((exitKalshi ?? 0) + (exitPoly ?? 0)) * trade.shares - exitFeesUsd;

  const updated = await db()
    .update(paperTrades)
    .set({
      status: "closed",
      closedAt: new Date(),
      exitKalshi,
      exitPoly,
      exitFeesUsd,
      realizedPnlUsd: proceeds - tradeCostUsd(trade),
      closeReason: "manual",
    })
    .where(and(eq(paperTrades.id, trade.id), eq(paperTrades.status, "open")))
    .returning({ id: paperTrades.id });
  return updated.length > 0 ? { ok: true } : { ok: false, reason: "already_closed" };
}

export type PaperTradeView = {
  trade: PaperTrade;
  link: MarketLink | null;
  kalshiMarket: Market | null;
  polymarketMarket: Market | null;
  event: Event | null;
  costUsd: number;
  mark: TradeMark;
};

/** One identity's book: profileId null = the owner's (admin) trades. */
export async function getPaperTradeViews(
  profileId: string | null,
): Promise<PaperTradeView[]> {
  const trades = await db()
    .select()
    .from(paperTrades)
    .where(
      profileId === null
        ? isNull(paperTrades.profileId)
        : eq(paperTrades.profileId, profileId),
    )
    .orderBy(desc(paperTrades.openedAt))
    .limit(500);
  if (trades.length === 0) return [];

  const linkIds = [...new Set(trades.map((t) => t.marketLinkId))];
  const links = await db()
    .select()
    .from(marketLinks)
    .where(inArray(marketLinks.id, linkIds));
  const linkById = new Map(links.map((l) => [l.id, l]));

  const marketIds = [
    ...new Set(links.flatMap((l) => [l.kalshiMarketId, l.polymarketMarketId])),
  ];
  const [marketRows, snaps] = await Promise.all([
    marketIds.length
      ? db().select().from(markets).where(inArray(markets.id, marketIds))
      : Promise.resolve([] as Market[]),
    latestSnapshots(marketIds),
  ]);
  const marketById = new Map(marketRows.map((m) => [m.id, m]));

  const eventIds = [
    ...new Set(marketRows.map((m) => m.eventId).filter(Boolean)),
  ] as string[];
  const eventRows = eventIds.length
    ? await db().select().from(events).where(inArray(events.id, eventIds))
    : [];
  const eventById = new Map(eventRows.map((e) => [e.id, e]));

  return trades.map((trade) => {
    const link = linkById.get(trade.marketLinkId) ?? null;
    const km = link ? (marketById.get(link.kalshiMarketId) ?? null) : null;
    const pm = link ? (marketById.get(link.polymarketMarketId) ?? null) : null;
    const event = km?.eventId ? (eventById.get(km.eventId) ?? null) : null;
    return {
      trade,
      link,
      kalshiMarket: km,
      polymarketMarket: pm,
      event,
      costUsd: tradeCostUsd(trade),
      mark: markToMarket(
        trade,
        km ? (snaps.get(km.id) ?? null) : null,
        pm ? (snaps.get(pm.id) ?? null) : null,
        feeCategoryFor(event?.category),
      ),
    };
  });
}

export type PaperStats = {
  startingBankroll: number;
  /** Bankroll minus capital tied up in open trades, plus realized P&L. */
  cashUsd: number;
  openCostUsd: number;
  openValueUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  equityUsd: number;
  closedCount: number;
  winCount: number;
  /** Σ realized / Σ expected over closed arb trades — the honesty metric. */
  expectedPnlUsd: number;
  captureRatio: number | null;
};

export function paperStats(views: PaperTradeView[]): PaperStats {
  const open = views.filter((v) => v.trade.status === "open");
  const closed = views.filter((v) => v.trade.status === "closed");

  const openCostUsd = open.reduce((s, v) => s + v.costUsd, 0);
  const openValueUsd = open.reduce((s, v) => s + (v.mark.valueUsd ?? v.costUsd), 0);
  const realizedPnlUsd = closed.reduce(
    (s, v) => s + (v.trade.realizedPnlUsd ?? 0),
    0,
  );

  const closedArbs = closed.filter((v) => v.trade.expectedEdge !== null);
  const expectedPnlUsd = closedArbs.reduce(
    (s, v) => s + (v.trade.expectedEdge ?? 0) * v.trade.shares,
    0,
  );
  const realizedOnArbs = closedArbs.reduce(
    (s, v) => s + (v.trade.realizedPnlUsd ?? 0),
    0,
  );

  const cashUsd = PAPER_STARTING_BANKROLL - openCostUsd + realizedPnlUsd;
  return {
    startingBankroll: PAPER_STARTING_BANKROLL,
    cashUsd,
    openCostUsd,
    openValueUsd,
    unrealizedPnlUsd: openValueUsd - openCostUsd,
    realizedPnlUsd,
    equityUsd: cashUsd + openValueUsd,
    closedCount: closed.length,
    winCount: closed.filter((v) => (v.trade.realizedPnlUsd ?? 0) > 0).length,
    expectedPnlUsd,
    captureRatio:
      expectedPnlUsd > 0 ? realizedOnArbs / expectedPnlUsd : null,
  };
}
