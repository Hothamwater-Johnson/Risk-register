import { sql } from "drizzle-orm";
import { CATALOG_SYNC_MAX_EVENTS } from "@/lib/config";
import { db } from "@/lib/db/client";
import { events, markets, PLATFORM } from "@/lib/db/schema";
import { chunk } from "@/lib/http";
import { runJob } from "@/lib/jobs";
import { getKalshiEventsPage, type KalshiEvent } from "@/lib/kalshi/client";
import {
  getGammaEventsPage,
  yesNoTokenIds,
  type GammaEvent,
} from "@/lib/polymarket/gamma";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return runJob(req, "sync-catalog", async () => {
    const kalshi = await syncKalshi();
    const polymarket = await syncPolymarket();
    return { kalshi, polymarket };
  });
}

type EventRow = typeof events.$inferInsert;
type MarketRow = typeof markets.$inferInsert;

async function syncKalshi() {
  let cursor: string | undefined;
  let eventCount = 0;
  let marketCount = 0;

  while (eventCount < CATALOG_SYNC_MAX_EVENTS) {
    const page = await getKalshiEventsPage({
      cursor,
      withNestedMarkets: true,
      status: "open",
    });
    if (page.events.length === 0) break;

    const eventRows: EventRow[] = page.events.map((e) => ({
      platformId: PLATFORM.kalshi,
      externalId: e.event_ticker,
      slug: e.event_ticker,
      title: e.title || e.event_ticker,
      category: e.category ?? null,
      closeTime: latestCloseTime(e),
      status: "open",
      volume24h: (e.markets ?? []).reduce((s, m) => s + (m.volume_24h ?? 0), 0),
      raw: { series_ticker: e.series_ticker },
      lastSyncedAt: new Date(),
    }));
    const idsByExternal = await upsertEvents(eventRows);

    const marketRows: MarketRow[] = page.events.flatMap((e) =>
      (e.markets ?? []).map((m) => ({
        eventId: idsByExternal.get(e.event_ticker) ?? null,
        platformId: PLATFORM.kalshi,
        externalId: m.ticker,
        question: m.title || m.ticker,
        outcomeLabel: m.yes_sub_title ?? m.subtitle ?? null,
        resolutionRules: m.rules_primary ?? null,
        status: m.status === "active" ? "open" : m.status,
        closeTime: m.close_time ? new Date(m.close_time) : null,
        volume: m.volume ?? null,
        volume24h: m.volume_24h ?? null,
        openInterest: m.open_interest ?? null,
        liquidity: m.liquidity ?? null,
        raw: { event_ticker: e.event_ticker, series_ticker: e.series_ticker },
        lastSyncedAt: new Date(),
      })),
    );
    marketCount += await upsertMarkets(marketRows);

    eventCount += page.events.length;
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return { events: eventCount, markets: marketCount };
}

function latestCloseTime(e: KalshiEvent): Date | null {
  const times = (e.markets ?? [])
    .map((m) => (m.close_time ? new Date(m.close_time).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.max(...times)) : null;
}

async function syncPolymarket() {
  let offset = 0;
  let eventCount = 0;
  let marketCount = 0;
  const pageSize = 100;

  while (eventCount < CATALOG_SYNC_MAX_EVENTS) {
    const page = await getGammaEventsPage({ limit: pageSize, offset });
    if (page.length === 0) break;

    const eventRows: EventRow[] = page.map((e) => ({
      platformId: PLATFORM.polymarket,
      externalId: e.id,
      slug: e.slug ?? null,
      title: e.title || e.id,
      category: e.category ?? null,
      closeTime: e.endDate ? new Date(e.endDate) : null,
      status: e.closed ? "closed" : "open",
      volume24h: e.volume24hr,
      raw: null,
      lastSyncedAt: new Date(),
    }));
    const idsByExternal = await upsertEvents(eventRows);

    const marketRows: MarketRow[] = page.flatMap((e) =>
      e.markets
        .filter((m) => m.conditionId)
        .map((m) => marketRowFromGamma(e, m, idsByExternal.get(e.id) ?? null)),
    );
    marketCount += await upsertMarkets(marketRows);

    eventCount += page.length;
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return { events: eventCount, markets: marketCount };
}

function marketRowFromGamma(
  e: GammaEvent,
  m: GammaEvent["markets"][number],
  eventId: string | null,
): MarketRow {
  const tokens = yesNoTokenIds(m);
  return {
    eventId,
    platformId: PLATFORM.polymarket,
    externalId: m.conditionId!,
    question: m.question || m.slug || m.id,
    outcomeLabel: m.groupItemTitle ?? null,
    yesTokenId: tokens.yes,
    noTokenId: tokens.no,
    resolutionRules: m.description ?? e.description ?? null,
    status: m.closed ? "closed" : "open",
    closeTime: m.endDate ? new Date(m.endDate) : null,
    volume: m.volumeNum,
    volume24h: m.volume24hr,
    liquidity: m.liquidityNum,
    raw: { gamma_market_id: m.id, slug: m.slug },
    lastSyncedAt: new Date(),
  };
}

/** Upsert events, returning a map of externalId → row id. */
async function upsertEvents(rows: EventRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const batch of chunk(rows, 200)) {
    const returned = await db()
      .insert(events)
      .values(batch)
      .onConflictDoUpdate({
        target: [events.platformId, events.externalId],
        set: {
          title: sql`excluded.title`,
          category: sql`excluded.category`,
          closeTime: sql`excluded.close_time`,
          status: sql`excluded.status`,
          volume24h: sql`excluded.volume_24h`,
          lastSyncedAt: sql`excluded.last_synced_at`,
        },
      })
      .returning({ id: events.id, externalId: events.externalId });
    for (const r of returned) out.set(r.externalId, r.id);
  }
  return out;
}

async function upsertMarkets(rows: MarketRow[]): Promise<number> {
  let n = 0;
  for (const batch of chunk(rows, 200)) {
    if (batch.length === 0) continue;
    await db()
      .insert(markets)
      .values(batch)
      .onConflictDoUpdate({
        target: [markets.platformId, markets.externalId],
        set: {
          question: sql`excluded.question`,
          outcomeLabel: sql`excluded.outcome_label`,
          yesTokenId: sql`excluded.yes_token_id`,
          noTokenId: sql`excluded.no_token_id`,
          resolutionRules: sql`excluded.resolution_rules`,
          status: sql`excluded.status`,
          closeTime: sql`excluded.close_time`,
          volume: sql`excluded.volume`,
          volume24h: sql`excluded.volume_24h`,
          openInterest: sql`excluded.open_interest`,
          liquidity: sql`excluded.liquidity`,
          lastSyncedAt: sql`excluded.last_synced_at`,
        },
      });
    n += batch.length;
  }
  return n;
}
