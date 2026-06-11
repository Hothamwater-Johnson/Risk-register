/**
 * Offline dry run of the matching heuristics: fetch both live catalogs,
 * run generateCandidates in memory, print the top-scored pairs. No DB,
 * no LLM. Run: pnpm dlx tsx scripts/match-dry-run.ts
 */
import type { Event } from "../src/lib/db/schema";
import { generateCandidates } from "../src/lib/matching/candidates";
import { getKalshiEventsPage } from "../src/lib/kalshi/client";
import { getGammaEventsPage } from "../src/lib/polymarket/gamma";

function fakeEvent(p: {
  title: string;
  category: string | null;
  closeTime: Date | null;
  externalId: string;
}): Event {
  return {
    id: p.externalId,
    platformId: 0,
    externalId: p.externalId,
    slug: null,
    title: p.title,
    category: p.category,
    closeTime: p.closeTime,
    status: "open",
    volume24h: null,
    raw: null,
    lastSyncedAt: null,
    createdAt: new Date(),
  } as unknown as Event;
}

async function main() {
  const kalshi: Event[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await getKalshiEventsPage({
      limit: 200,
      withNestedMarkets: true,
      cursor,
    });
    kalshi.push(
      ...res.events.map((e) =>
        fakeEvent({
          title: e.title || e.event_ticker,
          category: e.category ?? null,
          closeTime: latestClose(e.markets?.map((m) => m.close_time) ?? []),
          externalId: e.event_ticker,
        }),
      ),
    );
    if (!res.cursor) break;
    cursor = res.cursor;
  }

  const poly: Event[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await getGammaEventsPage({ limit: 100, offset });
    poly.push(
      ...page.map((e) =>
        fakeEvent({
          title: e.title || e.id,
          category: e.category ?? null,
          closeTime: e.endDate ? new Date(e.endDate) : null,
          externalId: e.id,
        }),
      ),
    );
    if (page.length < 100) break;
  }

  console.log(`catalogs: kalshi=${kalshi.length} polymarket=${poly.length}`);
  const t0 = Date.now();
  const candidates = generateCandidates(kalshi, poly);
  console.log(`candidates: ${candidates.length} in ${Date.now() - t0}ms\n`);
  for (const c of candidates.slice(0, 20)) {
    console.log(
      `${c.breakdown.total.toFixed(2)}  K: "${c.kalshiEvent.title.slice(0, 55)}"  P: "${c.polymarketEvent.title.slice(0, 55)}"`,
    );
  }
}

function latestClose(times: Array<string | null | undefined>): Date | null {
  const ts = times
    .map((t) => (t ? new Date(t).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  return ts.length ? new Date(Math.max(...ts)) : null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
