import { and, eq, inArray, sql } from "drizzle-orm";
import { SNAPSHOT_TOP_N } from "@/lib/config";
import { db } from "@/lib/db/client";
import {
  eventMatches,
  marketLinks,
  markets,
  priceSnapshots,
  PLATFORM,
  type Market,
} from "@/lib/db/schema";
import { chunk } from "@/lib/http";
import { runJob } from "@/lib/jobs";
import { summarizeKalshiBook } from "@/lib/arb/depth";
import {
  getKalshiMarketsByTickers,
  getKalshiOrderbook,
} from "@/lib/kalshi/client";
import { getClobBooks, summarizeBook } from "@/lib/polymarket/clob";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Cap per run on Kalshi orderbook calls (one HTTP call each). */
const MAX_KALSHI_BOOK_CALLS = 120;

type SnapshotRow = typeof priceSnapshots.$inferInsert;

export async function GET(req: Request) {
  return runJob(req, "snapshot", async () => {
    const ts = truncateToMinute(new Date());
    const { kalshiTracked, polyTracked, linkedKalshiIds } = await trackedMarkets();

    const rows: SnapshotRow[] = [
      ...(await snapshotKalshi(kalshiTracked, linkedKalshiIds, ts)),
      ...(await snapshotPolymarket(polyTracked, ts)),
    ];

    let inserted = 0;
    for (const batch of chunk(rows, 500)) {
      if (batch.length === 0) continue;
      await db().insert(priceSnapshots).values(batch).onConflictDoNothing();
      inserted += batch.length;
    }
    return {
      kalshi: kalshiTracked.length,
      polymarket: polyTracked.length,
      snapshots: inserted,
    };
  });
}

const truncateToMinute = (d: Date) =>
  new Date(Math.floor(d.getTime() / 60_000) * 60_000);

/**
 * Tracked = every market in a confirmed/auto-confirmed link, plus the top-N
 * open markets per platform by 24h volume (so history exists by the time a
 * pair gets confirmed).
 */
async function trackedMarkets(): Promise<{
  kalshiTracked: Market[];
  polyTracked: Market[];
  linkedKalshiIds: Set<string>;
}> {
  const linked = await db()
    .select({
      kalshiMarketId: marketLinks.kalshiMarketId,
      polymarketMarketId: marketLinks.polymarketMarketId,
    })
    .from(marketLinks)
    .innerJoin(eventMatches, eq(marketLinks.eventMatchId, eventMatches.id))
    .where(inArray(eventMatches.status, ["confirmed", "llm_confirmed"]));

  const linkedKalshiIds = new Set(linked.map((l) => l.kalshiMarketId));
  const linkedPolyIds = new Set(linked.map((l) => l.polymarketMarketId));

  const topOf = (platformId: number) =>
    db()
      .select()
      .from(markets)
      .where(and(eq(markets.platformId, platformId), eq(markets.status, "open")))
      .orderBy(sql`${markets.volume24h} DESC NULLS LAST`)
      .limit(SNAPSHOT_TOP_N);

  const [kalshiTop, polyTop] = await Promise.all([
    topOf(PLATFORM.kalshi),
    topOf(PLATFORM.polymarket),
  ]);

  const [kalshiLinked, polyLinked] = await Promise.all([
    linkedKalshiIds.size
      ? db().select().from(markets).where(inArray(markets.id, [...linkedKalshiIds]))
      : Promise.resolve([]),
    linkedPolyIds.size
      ? db().select().from(markets).where(inArray(markets.id, [...linkedPolyIds]))
      : Promise.resolve([]),
  ]);

  return {
    kalshiTracked: dedupe([...kalshiLinked, ...kalshiTop]),
    polyTracked: dedupe([...polyLinked, ...polyTop]).filter((m) =>
      Boolean(m.yesTokenId),
    ),
    linkedKalshiIds,
  };
}

function dedupe(ms: Market[]): Market[] {
  const seen = new Set<string>();
  return ms.filter((m) => !seen.has(m.id) && seen.add(m.id));
}

async function snapshotKalshi(
  tracked: Market[],
  linkedIds: Set<string>,
  ts: Date,
): Promise<SnapshotRow[]> {
  const byTicker = new Map(tracked.map((m) => [m.externalId, m]));
  const rows: SnapshotRow[] = [];

  for (const batch of chunk([...byTicker.keys()], 50)) {
    for (const q of await getKalshiMarketsByTickers(batch)) {
      const market = byTicker.get(q.ticker);
      if (!market) continue;
      const yesBid = q.yes_bid_dollars;
      const yesAsk = q.yes_ask_dollars;
      rows.push({
        marketId: market.id,
        ts,
        yesBid,
        yesAsk,
        noBid: q.no_bid_dollars,
        noAsk: q.no_ask_dollars,
        lastPrice: q.last_price_dollars,
        mid: yesBid !== null && yesAsk !== null ? (yesBid + yesAsk) / 2 : null,
        volume24h: q.volume_24h_fp ?? null,
      });
    }
  }

  // Depth only for linked markets (one orderbook call each), capped per run.
  const linkedRows = rows.filter((r) => linkedIds.has(r.marketId));
  for (const row of linkedRows.slice(0, MAX_KALSHI_BOOK_CALLS)) {
    const market = tracked.find((m) => m.id === row.marketId);
    if (!market) continue;
    try {
      const depth = summarizeKalshiBook(await getKalshiOrderbook(market.externalId));
      row.bidDepthUsd = depth.bidDepthUsd;
      row.askDepthUsd = depth.askDepthUsd;
    } catch {
      // Depth is best-effort; quote row still gets stored.
    }
  }
  return rows;
}

async function snapshotPolymarket(
  tracked: Market[],
  ts: Date,
): Promise<SnapshotRow[]> {
  const byToken = new Map(
    tracked.filter((m) => m.yesTokenId).map((m) => [m.yesTokenId!, m]),
  );
  const books = await getClobBooks([...byToken.keys()]);

  const rows: SnapshotRow[] = [];
  for (const [tokenId, market] of byToken) {
    const book = books.get(tokenId);
    if (!book) continue;
    const s = summarizeBook(book);
    rows.push({
      marketId: market.id,
      ts,
      yesBid: s.bestBid,
      yesAsk: s.bestAsk,
      // Binary complement of the YES book; good enough for snapshots.
      noBid: s.bestAsk === null ? null : 1 - s.bestAsk,
      noAsk: s.bestBid === null ? null : 1 - s.bestBid,
      lastPrice: null,
      mid: s.mid,
      bidDepthUsd: s.bidDepthUsd,
      askDepthUsd: s.askDepthUsd,
      volume24h: market.volume24h,
    });
  }
  return rows;
}
