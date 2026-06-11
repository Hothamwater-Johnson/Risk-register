import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { computeSpread, type Quote, type SpreadResult } from "./arb/spread";
import { db } from "./db/client";
import {
  eventMatches,
  events,
  marketLinks,
  markets,
  priceSnapshots,
  PLATFORM,
  type Event,
  type EventMatch,
  type Market,
  type MarketLink,
  type PriceSnapshot,
} from "./db/schema";

export type LinkView = {
  link: MarketLink;
  kalshiMarket: Market;
  polymarketMarket: Market;
  kalshiSnapshot: PriceSnapshot | null;
  polymarketSnapshot: PriceSnapshot | null;
  spread: SpreadResult;
};

export type PairView = {
  match: EventMatch;
  kalshiEvent: Event;
  polymarketEvent: Event;
  links: LinkView[];
  /** Largest mid-vs-mid disagreement across linked outcomes. */
  maxDisagreement: number | null;
  /** Best after-fee arb edge across linked outcomes, if any is positive. */
  bestNetEdge: number | null;
  rulesDiffer: boolean;
};

const VISIBLE_MATCH_STATUSES = ["confirmed", "llm_confirmed"] as const;

export function quoteFromSnapshot(s: PriceSnapshot | null): Quote {
  return {
    yesBid: s?.yesBid ?? null,
    yesAsk: s?.yesAsk ?? null,
    noBid: s?.noBid ?? null,
    noAsk: s?.noAsk ?? null,
    mid: s?.mid ?? null,
    bidDepthUsd: s?.bidDepthUsd ?? null,
    askDepthUsd: s?.askDepthUsd ?? null,
  };
}

/** Latest snapshot per market id. */
export async function latestSnapshots(
  marketIds: string[],
): Promise<Map<string, PriceSnapshot>> {
  if (marketIds.length === 0) return new Map();
  const rows = await db()
    .selectDistinctOn([priceSnapshots.marketId])
    .from(priceSnapshots)
    .where(inArray(priceSnapshots.marketId, marketIds))
    .orderBy(priceSnapshots.marketId, desc(priceSnapshots.ts));
  return new Map(rows.map((r) => [r.marketId, r]));
}

/** Snapshot per market closest to (but before) `before`. */
async function snapshotsBefore(
  marketIds: string[],
  before: Date,
): Promise<Map<string, PriceSnapshot>> {
  if (marketIds.length === 0) return new Map();
  const rows = await db()
    .selectDistinctOn([priceSnapshots.marketId])
    .from(priceSnapshots)
    .where(
      and(
        inArray(priceSnapshots.marketId, marketIds),
        sql`${priceSnapshots.ts} <= ${before.toISOString()}`,
      ),
    )
    .orderBy(priceSnapshots.marketId, desc(priceSnapshots.ts));
  return new Map(rows.map((r) => [r.marketId, r]));
}

async function buildPairViews(matches: EventMatch[]): Promise<PairView[]> {
  if (matches.length === 0) return [];

  const matchIds = matches.map((m) => m.id);
  const links = await db()
    .select()
    .from(marketLinks)
    .where(inArray(marketLinks.eventMatchId, matchIds));

  const eventIds = [
    ...new Set(matches.flatMap((m) => [m.kalshiEventId, m.polymarketEventId])),
  ];
  const marketIds = [
    ...new Set(links.flatMap((l) => [l.kalshiMarketId, l.polymarketMarketId])),
  ];

  const [eventRows, marketRows, snaps] = await Promise.all([
    db().select().from(events).where(inArray(events.id, eventIds)),
    marketIds.length
      ? db().select().from(markets).where(inArray(markets.id, marketIds))
      : Promise.resolve([] as Market[]),
    latestSnapshots(marketIds),
  ]);
  const eventById = new Map(eventRows.map((e) => [e.id, e]));
  const marketById = new Map(marketRows.map((m) => [m.id, m]));

  return matches.flatMap((match) => {
    const kalshiEvent = eventById.get(match.kalshiEventId);
    const polymarketEvent = eventById.get(match.polymarketEventId);
    if (!kalshiEvent || !polymarketEvent) return [];

    const linkViews: LinkView[] = links
      .filter((l) => l.eventMatchId === match.id)
      .flatMap((link) => {
        const km = marketById.get(link.kalshiMarketId);
        const pm = marketById.get(link.polymarketMarketId);
        if (!km || !pm) return [];
        const ks = snaps.get(km.id) ?? null;
        const ps = snaps.get(pm.id) ?? null;
        return [
          {
            link,
            kalshiMarket: km,
            polymarketMarket: pm,
            kalshiSnapshot: ks,
            polymarketSnapshot: ps,
            spread: computeSpread(
              quoteFromSnapshot(ks),
              quoteFromSnapshot(ps),
              kalshiEvent.category,
              { outcomeInverted: link.outcomeInverted },
            ),
          },
        ];
      });

    const disagreements = linkViews
      .map((l) => l.spread.disagreement)
      .filter((d): d is number => d !== null);
    const edges = linkViews
      .map((l) => l.spread.arb)
      .filter((a) => a !== null && !a.thinBook && a.netEdge > 0)
      .map((a) => a!.netEdge);

    const breakdown = match.scoreBreakdown as {
      llm?: { rulesDiffer?: boolean };
    } | null;

    return [
      {
        match,
        kalshiEvent,
        polymarketEvent,
        links: linkViews,
        maxDisagreement: disagreements.length ? Math.max(...disagreements) : null,
        bestNetEdge: edges.length ? Math.max(...edges) : null,
        rulesDiffer: breakdown?.llm?.rulesDiffer ?? false,
      },
    ];
  });
}

/** All publicly visible matched pairs with live spread math, biggest gaps first. */
export async function getActivePairs(limit = 50): Promise<PairView[]> {
  const matches = await db()
    .select()
    .from(eventMatches)
    .where(inArray(eventMatches.status, [...VISIBLE_MATCH_STATUSES]))
    .limit(200);
  const views = await buildPairViews(matches);
  return views
    .filter((v) => v.links.length > 0)
    .sort((a, b) => (b.maxDisagreement ?? -1) - (a.maxDisagreement ?? -1))
    .slice(0, limit);
}

export async function getPairBySlug(slug: string): Promise<PairView | null> {
  const matches = await db()
    .select()
    .from(eventMatches)
    .where(eq(eventMatches.pairSlug, slug))
    .limit(1);
  if (matches.length === 0) return null;
  const [view] = await buildPairViews(matches);
  return view ?? null;
}

export type Mover = {
  market: Market;
  event: Event | null;
  pairSlug: string | null;
  midNow: number;
  mid24hAgo: number;
  change: number;
};

/** Largest 24h mid-price moves among snapshotted markets. */
export async function getMovers(limit = 10): Promise<Mover[]> {
  const top = await db()
    .select()
    .from(markets)
    .where(eq(markets.status, "open"))
    .orderBy(sql`${markets.volume24h} DESC NULLS LAST`)
    .limit(300);
  const ids = top.map((m) => m.id);

  const [now, before] = await Promise.all([
    latestSnapshots(ids),
    snapshotsBefore(ids, new Date(Date.now() - 24 * 3600_000)),
  ]);

  const eventIds = [...new Set(top.map((m) => m.eventId).filter(Boolean))] as string[];
  const [eventRows, pairSlugs] = await Promise.all([
    eventIds.length
      ? db().select().from(events).where(inArray(events.id, eventIds))
      : Promise.resolve([] as Event[]),
    eventIds.length
      ? db()
          .select({
            kalshiEventId: eventMatches.kalshiEventId,
            polymarketEventId: eventMatches.polymarketEventId,
            pairSlug: eventMatches.pairSlug,
          })
          .from(eventMatches)
          .where(
            and(
              inArray(eventMatches.status, [...VISIBLE_MATCH_STATUSES]),
              or(
                inArray(eventMatches.kalshiEventId, eventIds),
                inArray(eventMatches.polymarketEventId, eventIds),
              ),
            ),
          )
      : Promise.resolve([]),
  ]);
  const eventById = new Map(eventRows.map((e) => [e.id, e]));
  const slugByEvent = new Map<string, string>();
  for (const p of pairSlugs) {
    if (!p.pairSlug) continue;
    slugByEvent.set(p.kalshiEventId, p.pairSlug);
    slugByEvent.set(p.polymarketEventId, p.pairSlug);
  }

  const movers: Mover[] = [];
  for (const m of top) {
    const a = before.get(m.id)?.mid;
    const b = now.get(m.id)?.mid;
    if (a == null || b == null) continue;
    movers.push({
      market: m,
      event: m.eventId ? (eventById.get(m.eventId) ?? null) : null,
      pairSlug: m.eventId ? (slugByEvent.get(m.eventId) ?? null) : null,
      midNow: b,
      mid24hAgo: a,
      change: b - a,
    });
  }
  return movers
    .sort((x, y) => Math.abs(y.change) - Math.abs(x.change))
    .slice(0, limit);
}

export type SpreadPoint = {
  ts: string;
  kalshi: number | null;
  polymarket: number | null;
  gap: number | null;
};

/** Cross-platform spread history for one link, from our own snapshots. */
export async function getSpreadHistory(
  link: MarketLink,
  days = 7,
): Promise<SpreadPoint[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db()
    .select({
      marketId: priceSnapshots.marketId,
      ts: priceSnapshots.ts,
      mid: priceSnapshots.mid,
    })
    .from(priceSnapshots)
    .where(
      and(
        inArray(priceSnapshots.marketId, [
          link.kalshiMarketId,
          link.polymarketMarketId,
        ]),
        sql`${priceSnapshots.ts} >= ${since.toISOString()}`,
      ),
    )
    .orderBy(priceSnapshots.ts);

  const byTs = new Map<string, { kalshi: number | null; polymarket: number | null }>();
  for (const r of rows) {
    const key = r.ts.toISOString();
    const entry = byTs.get(key) ?? { kalshi: null, polymarket: null };
    if (r.marketId === link.kalshiMarketId) entry.kalshi = r.mid;
    else {
      entry.polymarket =
        link.outcomeInverted && r.mid !== null ? 1 - r.mid : r.mid;
    }
    byTs.set(key, entry);
  }

  return [...byTs.entries()].map(([ts, v]) => ({
    ts,
    kalshi: v.kalshi,
    polymarket: v.polymarket,
    gap:
      v.kalshi !== null && v.polymarket !== null
        ? Math.abs(v.kalshi - v.polymarket)
        : null,
  }));
}

export type MarketSearchRow = {
  market: Market;
  event: Event | null;
  pairSlug: string | null;
  /** Latest snapshot mid (fallback last trade) in the market's own YES terms. */
  prob: number | null;
  /**
   * Linked market's comparable probability on the other platform, with
   * outcome inversion applied so both numbers answer the same question.
   */
  counterpartProb: number | null;
};

export async function searchMarkets(opts: {
  q?: string;
  matchedOnly?: boolean;
  limit?: number;
}): Promise<MarketSearchRow[]> {
  const conditions = [eq(markets.status, "open")];
  if (opts.q) conditions.push(ilike(markets.question, `%${opts.q}%`));
  if (opts.matchedOnly) {
    // Restrict the query itself, not just the page, to linked markets.
    const linked = await db()
      .select({
        kalshiMarketId: marketLinks.kalshiMarketId,
        polymarketMarketId: marketLinks.polymarketMarketId,
      })
      .from(marketLinks)
      .innerJoin(eventMatches, eq(marketLinks.eventMatchId, eventMatches.id))
      .where(inArray(eventMatches.status, [...VISIBLE_MATCH_STATUSES]));
    const linkedIds = [
      ...new Set(linked.flatMap((l) => [l.kalshiMarketId, l.polymarketMarketId])),
    ];
    if (linkedIds.length === 0) return [];
    conditions.push(inArray(markets.id, linkedIds));
  }

  const rows = await db()
    .select()
    .from(markets)
    .where(and(...conditions))
    .orderBy(sql`${markets.volume24h} DESC NULLS LAST`)
    .limit(opts.limit ?? 100);

  const marketIds = rows.map((m) => m.id);
  const eventIds = [...new Set(rows.map((m) => m.eventId).filter(Boolean))] as string[];
  const [eventRows, slugRows, linkRows] = await Promise.all([
    eventIds.length
      ? db().select().from(events).where(inArray(events.id, eventIds))
      : Promise.resolve([] as Event[]),
    eventIds.length
      ? db()
          .select({
            kalshiEventId: eventMatches.kalshiEventId,
            polymarketEventId: eventMatches.polymarketEventId,
            pairSlug: eventMatches.pairSlug,
          })
          .from(eventMatches)
          .where(inArray(eventMatches.status, [...VISIBLE_MATCH_STATUSES]))
      : Promise.resolve([]),
    marketIds.length
      ? db()
          .select({
            kalshiMarketId: marketLinks.kalshiMarketId,
            polymarketMarketId: marketLinks.polymarketMarketId,
            outcomeInverted: marketLinks.outcomeInverted,
          })
          .from(marketLinks)
          .innerJoin(eventMatches, eq(marketLinks.eventMatchId, eventMatches.id))
          .where(
            and(
              inArray(eventMatches.status, [...VISIBLE_MATCH_STATUSES]),
              or(
                inArray(marketLinks.kalshiMarketId, marketIds),
                inArray(marketLinks.polymarketMarketId, marketIds),
              ),
            ),
          )
      : Promise.resolve([]),
  ]);
  const eventById = new Map(eventRows.map((e) => [e.id, e]));
  const slugByEvent = new Map<string, string>();
  for (const s of slugRows) {
    if (!s.pairSlug) continue;
    slugByEvent.set(s.kalshiEventId, s.pairSlug);
    slugByEvent.set(s.polymarketEventId, s.pairSlug);
  }

  const counterpart = new Map<string, { id: string; inverted: boolean }>();
  for (const l of linkRows) {
    const inverted = Boolean(l.outcomeInverted);
    counterpart.set(l.kalshiMarketId, { id: l.polymarketMarketId, inverted });
    counterpart.set(l.polymarketMarketId, { id: l.kalshiMarketId, inverted });
  }
  const snaps = await latestSnapshots([
    ...new Set([...marketIds, ...[...counterpart.values()].map((c) => c.id)]),
  ]);
  const probOf = (id: string): number | null => {
    const s = snaps.get(id);
    return s?.mid ?? s?.lastPrice ?? null;
  };

  return rows
    .map((m) => {
      const other = counterpart.get(m.id);
      const otherProb = other ? probOf(other.id) : null;
      return {
        market: m,
        event: m.eventId ? (eventById.get(m.eventId) ?? null) : null,
        pairSlug: m.eventId ? (slugByEvent.get(m.eventId) ?? null) : null,
        prob: probOf(m.id),
        counterpartProb:
          otherProb !== null && other?.inverted ? 1 - otherProb : otherProb,
      };
    })
    .filter((r) => !opts.matchedOnly || r.pairSlug !== null);
}

/** Best-effort outbound links to the platforms' own pages. */
export function platformUrl(market: Market, event: Event | null): string {
  if (market.platformId === PLATFORM.polymarket) {
    return event?.slug
      ? `https://polymarket.com/event/${event.slug}`
      : "https://polymarket.com";
  }
  const raw = market.raw as { series_ticker?: string } | null;
  const series = raw?.series_ticker ?? event?.externalId ?? market.externalId;
  return `https://kalshi.com/markets/${series.toLowerCase()}`;
}
