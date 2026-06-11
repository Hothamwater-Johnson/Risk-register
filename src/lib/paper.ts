import { cookies } from "next/headers";
import { desc, inArray } from "drizzle-orm";
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

export const PAPER_COOKIE = "paper_token";

export const PAPER_STARTING_BANKROLL = Number(
  process.env.PAPER_STARTING_BANKROLL ?? 1000,
);

/** Paper trading is personal: reuse ADMIN_TOKEN, via cookie or explicit token. */
export async function hasPaperAccess(token?: string | null): Promise<boolean> {
  if (isAdmin(token)) return true;
  const store = await cookies();
  return isAdmin(store.get(PAPER_COOKIE)?.value);
}

/** Cost basis of one trade in USD, entry fees included. */
export function tradeCostUsd(t: PaperTrade): number {
  const perShare = (t.kalshiEntry ?? 0) + (t.polyEntry ?? 0);
  return perShare * t.shares + t.entryFeesUsd;
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
  /** True when any open leg has no current quote to mark against. */
  stale: boolean;
};

export function markToMarket(
  t: PaperTrade,
  kalshiSnap: PriceSnapshot | null,
  polySnap: PriceSnapshot | null,
  feeCat: FeeCategory,
): TradeMark {
  if (t.status !== "open") {
    return { valueUsd: null, unrealizedPnlUsd: null, stale: false };
  }
  let perShare = 0;
  let exitFees = 0;
  let stale = false;

  if (t.kalshiSide) {
    const bid = legBid(t.kalshiSide, kalshiSnap);
    if (bid === null) stale = true;
    else {
      perShare += bid;
      exitFees += kalshiTakerFeePerShare(bid, feeCat) * t.shares;
    }
  }
  if (t.polySide) {
    const bid = legBid(t.polySide, polySnap);
    if (bid === null) stale = true;
    else {
      perShare += bid;
      exitFees += polymarketTakerFeePerShare(bid, feeCat, { isSell: true }) * t.shares;
    }
  }
  if (stale) return { valueUsd: null, unrealizedPnlUsd: null, stale };

  const valueUsd = perShare * t.shares - exitFees;
  return { valueUsd, unrealizedPnlUsd: valueUsd - tradeCostUsd(t), stale };
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

export type PaperTradeView = {
  trade: PaperTrade;
  link: MarketLink | null;
  kalshiMarket: Market | null;
  polymarketMarket: Market | null;
  event: Event | null;
  costUsd: number;
  mark: TradeMark;
};

export async function getPaperTradeViews(): Promise<PaperTradeView[]> {
  const trades = await db()
    .select()
    .from(paperTrades)
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
