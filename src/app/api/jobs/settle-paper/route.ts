import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { marketLinks, markets, paperTrades } from "@/lib/db/schema";
import { chunk } from "@/lib/http";
import { runJob } from "@/lib/jobs";
import { getKalshiMarketsByTickers } from "@/lib/kalshi/client";
import { settleOpenTrade } from "@/lib/paper";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Auto-settle paper trades from the canonical (Kalshi) side. Settled markets
 * never appear in the open-events catalog sync, so this job re-fetches the
 * exact tickers that open trades sit on. It settles ONLY on the platform's
 * own verdict — status "finalized" with result exactly "yes" or "no"
 * (verified live 2026-06-11, scripts/check-kalshi-settlement.ts); the
 * intermediate "determined" status is still inside its settlement timer and
 * is left for the next run. Anything else is counted and skipped, never
 * guessed. Manual Settled YES/NO buttons remain the override; the
 * status='open' guard in settleOpenTrade makes the two paths race-safe.
 */
export async function GET(req: Request) {
  return runJob(req, "settle-paper", async () => {
    const openTrades = await db()
      .select()
      .from(paperTrades)
      .where(eq(paperTrades.status, "open"));
    if (openTrades.length === 0) return { openTrades: 0, settledTrades: 0 };

    const linkIds = [...new Set(openTrades.map((t) => t.marketLinkId))];
    const links = await db()
      .select()
      .from(marketLinks)
      .where(inArray(marketLinks.id, linkIds));
    const linkById = new Map(links.map((l) => [l.id, l]));

    const kalshiMarketIds = [...new Set(links.map((l) => l.kalshiMarketId))];
    const marketRows = kalshiMarketIds.length
      ? await db().select().from(markets).where(inArray(markets.id, kalshiMarketIds))
      : [];
    const marketByTicker = new Map(marketRows.map((m) => [m.externalId, m]));

    const tradesByKalshiMarket = new Map<string, typeof openTrades>();
    for (const t of openTrades) {
      const link = linkById.get(t.marketLinkId);
      if (!link) continue;
      const list = tradesByKalshiMarket.get(link.kalshiMarketId) ?? [];
      list.push(t);
      tradesByKalshiMarket.set(link.kalshiMarketId, list);
    }

    let finalized = 0;
    let settledTrades = 0;
    let alreadyClosed = 0;
    let awaitingSettlement = 0;
    let stillOpen = 0;

    for (const batch of chunk([...marketByTicker.keys()], 100)) {
      const live = await getKalshiMarketsByTickers(batch);
      for (const lm of live) {
        const row = marketByTicker.get(lm.ticker);
        if (!row) continue;

        if (lm.status !== "finalized") {
          if (lm.result === "yes" || lm.result === "no") awaitingSettlement++;
          else stillOpen++;
          continue;
        }
        if (lm.result !== "yes" && lm.result !== "no") {
          // Finalized without a binary result (void/scratch/unknown shape):
          // never guess — leave it for a human and the manual buttons.
          awaitingSettlement++;
          continue;
        }

        finalized++;
        // App vocabulary is open|closed; Kalshi's "finalized" stays in the
        // job's gating above. `result` carries the settled outcome.
        await db()
          .update(markets)
          .set({ status: "closed", result: lm.result })
          .where(eq(markets.id, row.id));

        const kalshiYesWon = lm.result === "yes";
        const tradesOnMarket = tradesByKalshiMarket.get(row.id) ?? [];
        for (const trade of tradesOnMarket) {
          const link = linkById.get(trade.marketLinkId)!;
          const settled = await settleOpenTrade(trade, link.outcomeInverted, kalshiYesWon);
          if (settled) settledTrades++;
          else alreadyClosed++;
        }
      }
    }

    return {
      openTrades: openTrades.length,
      marketsChecked: marketByTicker.size,
      finalized,
      settledTrades,
      alreadyClosed,
      awaitingSettlement,
      stillOpen,
    };
  });
}
