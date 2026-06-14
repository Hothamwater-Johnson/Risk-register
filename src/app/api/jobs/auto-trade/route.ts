import { feeCategoryFor } from "@/lib/arb/fees";
import { isAutoTraderRunning } from "@/lib/autoTrader";
import {
  AUTO_TRADER_CLOSE_RULES_DIFFER,
  AUTO_TRADER_MAX_OPEN,
  AUTO_TRADER_MAX_PER_PAIR,
  AUTO_TRADER_MIN_EDGE,
  AUTO_TRADER_STAKE_USD,
  AUTO_TRADER_STOP_USD,
  AUTO_TRADER_TAKE_PROFIT_USD,
} from "@/lib/config";
import { db } from "@/lib/db/client";
import { paperTrades } from "@/lib/db/schema";
import { runJob } from "@/lib/jobs";
import {
  arbEntryCost,
  arbLegsFromResult,
  botIdempotencyKey,
  closeTradeAtMarket,
  ensureBotProfileId,
  getPaperTradeViews,
  paperStats,
} from "@/lib/paper";
import { getActivePairs } from "@/lib/queries";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Paper auto-trader (admin-only). On each run the bot:
 *  1. CLOSES open positions that hit a take-profit / stop-loss, or that sit on a
 *     rules-differ pair with a positive mark (real basis risk — bank it). A
 *     clean arb otherwise rides to settlement, where it's worth $1/share with no
 *     exit fees; closing early sells at the bid and pays taker fees again.
 *  2. OPENS arbs whose after-fee netEdge clears AUTO_TRADER_MIN_EDGE and whose
 *     book isn't thin, sized so notional never exceeds the book's executable
 *     depth (the app's honesty thesis) or available paper cash.
 *
 * Everything keys off a reserved bot profile, so the bot's book never commingles
 * with the owner's manual book. settle-paper still settles any position the bot
 * leaves open. Reuses the same SpreadResult/arb the public dashboard renders.
 */
export async function GET(req: Request) {
  return runJob(req, "auto-trade", async () => {
    // The start/stop button is the live control: only trade when the active
    // session is 'running'. (Falls back to AUTO_TRADER_ENABLED pre-migration.)
    if (!(await isAutoTraderRunning())) return { skipped: "paused or no active session" };

    const botProfileId = await ensureBotProfileId();
    const pairs = await getActivePairs(50);

    // rulesDiffer is a pair-level fact; map it onto each link for the close pass.
    // Links no longer in the active set default to "no basis risk known".
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

      let reason: "take_profit" | "stop_loss" | "rules_differ" | null = null;
      if (pnl >= AUTO_TRADER_TAKE_PROFIT_USD) reason = "take_profit";
      else if (pnl <= -AUTO_TRADER_STOP_USD) reason = "stop_loss";
      else if (AUTO_TRADER_CLOSE_RULES_DIFFER && rulesDiffer && pnl > 0) reason = "rules_differ";
      if (!reason) continue;

      const res = await closeTradeAtMarket(v.trade, v.link, feeCategoryFor(v.event?.category));
      if (res.ok) closes[reason]++;
      else closes[res.reason]++;
    }

    // ---- Open pass: re-read the book so cash & open counts reflect the closes. ----
    const views = await getPaperTradeViews(botProfileId);
    const stats = paperStats(views);
    let cashUsd = stats.cashUsd;
    let currentOpen = views.filter((v) => v.trade.status === "open").length;
    const openPerLink = new Map<string, number>();
    for (const v of views) {
      if (v.trade.status !== "open") continue;
      openPerLink.set(v.trade.marketLinkId, (openPerLink.get(v.trade.marketLinkId) ?? 0) + 1);
    }

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
      hitMaxOpen: 0,
    };

    for (const pair of pairs) {
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
        if ((openPerLink.get(lv.link.id) ?? 0) >= AUTO_TRADER_MAX_PER_PAIR) {
          opens.skippedHasPosition++;
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
          // Post-floor exact recheck guards the float edge where priceWithFees
          // understated true cost.
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
        openPerLink.set(lv.link.id, (openPerLink.get(lv.link.id) ?? 0) + 1);
      }
    }

    return { ...opens, closes, cashUsdAfter: Number(cashUsd.toFixed(2)) };
  });
}
