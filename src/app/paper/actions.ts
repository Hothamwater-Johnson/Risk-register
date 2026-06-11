"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import {
  feeCategoryFor,
  kalshiTakerFeePerShare,
  polymarketTakerFeePerShare,
} from "@/lib/arb/fees";
import { computeSpread } from "@/lib/arb/spread";
import { isAdmin } from "@/lib/config";
import { db } from "@/lib/db/client";
import {
  events,
  marketLinks,
  markets,
  paperTrades,
  type PaperSide,
} from "@/lib/db/schema";
import {
  getPaperTradeViews,
  hasPaperAccess,
  legBid,
  PAPER_COOKIE,
  paperStats,
  settlementValuePerShare,
  tradeCostUsd,
} from "@/lib/paper";
import { latestSnapshots, quoteFromSnapshot } from "@/lib/queries";

/**
 * All fills are computed server-side from the latest snapshots at submit
 * time — client-displayed prices are never trusted. That means the fill you
 * get can differ from the number you clicked, which is exactly the slippage
 * a real order would see between glance and click.
 */

export async function paperLogin(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  if (!isAdmin(token)) throw new Error("Wrong token");
  const store = await cookies();
  store.set(PAPER_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/paper");
}

export async function paperLogout() {
  (await cookies()).delete(PAPER_COOKIE);
  revalidatePath("/paper");
}

export type OpenTradeMode =
  | "arb"
  | "yes_kalshi"
  | "no_kalshi"
  | "yes_polymarket"
  | "no_polymarket";

export async function openPaperTrade(formData: FormData) {
  if (!(await hasPaperAccess(formData.get("token") as string | null))) {
    throw new Error("Unauthorized");
  }
  const linkId = String(formData.get("linkId") ?? "");
  const mode = String(formData.get("mode") ?? "") as OpenTradeMode;
  const shares = Number(formData.get("shares") ?? 0);
  const thesis = String(formData.get("thesis") ?? "").trim() || null;
  if (!Number.isFinite(shares) || shares <= 0 || shares > 100_000) {
    throw new Error("Shares must be a positive number");
  }

  const [link] = await db()
    .select()
    .from(marketLinks)
    .where(eq(marketLinks.id, linkId))
    .limit(1);
  if (!link) throw new Error("Unknown market link");

  const [[km], [pm]] = await Promise.all([
    db().select().from(markets).where(eq(markets.id, link.kalshiMarketId)).limit(1),
    db().select().from(markets).where(eq(markets.id, link.polymarketMarketId)).limit(1),
  ]);
  if (!km || !pm) throw new Error("Markets missing for link");

  const event = km.eventId
    ? (await db().select().from(events).where(eq(events.id, km.eventId)).limit(1))[0]
    : null;
  const feeCat = feeCategoryFor(event?.category);

  const snaps = await latestSnapshots([km.id, pm.id]);
  const ks = snaps.get(km.id) ?? null;
  const ps = snaps.get(pm.id) ?? null;
  const spread = computeSpread(
    quoteFromSnapshot(ks),
    quoteFromSnapshot(ps),
    event?.category,
    { outcomeInverted: link.outcomeInverted },
  );

  // Sides stored in each venue's own terms; `flip` maps the canonical
  // (Kalshi-question) side onto the real Polymarket book when inverted.
  const flip = (s: PaperSide): PaperSide =>
    link.outcomeInverted ? (s === "yes" ? "no" : "yes") : s;

  let kalshiSide: PaperSide | null = null;
  let kalshiEntry: number | null = null;
  let polySide: PaperSide | null = null;
  let polyEntry: number | null = null;
  let expectedEdge: number | null = null;
  let thinBook = false;

  if (mode === "arb") {
    const arb = spread.arb;
    if (!arb) throw new Error("No arb is currently available on this pair");
    if (arb.direction === "yes_kalshi") {
      kalshiSide = "yes";
      kalshiEntry = arb.yesAsk;
      polySide = flip("no");
      polyEntry = arb.noAsk;
    } else {
      polySide = flip("yes");
      polyEntry = arb.yesAsk;
      kalshiSide = "no";
      kalshiEntry = arb.noAsk;
    }
    expectedEdge = arb.netEdge;
    thinBook = arb.thinBook;
  } else if (mode === "yes_kalshi" || mode === "no_kalshi") {
    kalshiSide = mode === "yes_kalshi" ? "yes" : "no";
    kalshiEntry = kalshiSide === "yes" ? (ks?.yesAsk ?? null) : (ks?.noAsk ?? null);
    if (kalshiEntry === null) throw new Error("No current Kalshi ask to fill at");
  } else if (mode === "yes_polymarket" || mode === "no_polymarket") {
    polySide = flip(mode === "yes_polymarket" ? "yes" : "no");
    polyEntry = polySide === "yes" ? (ps?.yesAsk ?? null) : (ps?.noAsk ?? null);
    if (polyEntry === null) throw new Error("No current Polymarket ask to fill at");
  } else {
    throw new Error("Unknown trade mode");
  }

  const entryFeesUsd =
    (kalshiEntry !== null ? kalshiTakerFeePerShare(kalshiEntry, feeCat) * shares : 0) +
    (polyEntry !== null ? polymarketTakerFeePerShare(polyEntry, feeCat) * shares : 0);
  const costUsd =
    ((kalshiEntry ?? 0) + (polyEntry ?? 0)) * shares + entryFeesUsd;

  const stats = paperStats(await getPaperTradeViews());
  if (costUsd > stats.cashUsd) {
    throw new Error(
      `Costs $${costUsd.toFixed(2)} but only $${stats.cashUsd.toFixed(2)} paper cash is free`,
    );
  }

  await db().insert(paperTrades).values({
    marketLinkId: link.id,
    kalshiSide,
    kalshiEntry,
    polySide,
    polyEntry,
    shares,
    entryFeesUsd,
    expectedEdge,
    entryDisagreement: spread.disagreement,
    thinBookAtEntry: thinBook,
    thesis,
  });
  revalidatePath("/paper");
}

export async function closePaperTrade(formData: FormData) {
  if (!(await hasPaperAccess(formData.get("token") as string | null))) {
    throw new Error("Unauthorized");
  }
  const tradeId = String(formData.get("tradeId") ?? "");
  const [trade] = await db()
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.id, tradeId))
    .limit(1);
  if (!trade || trade.status !== "open") throw new Error("No such open trade");

  const [link] = await db()
    .select()
    .from(marketLinks)
    .where(eq(marketLinks.id, trade.marketLinkId))
    .limit(1);
  if (!link) throw new Error("Market link missing");

  const [km] = await db()
    .select()
    .from(markets)
    .where(eq(markets.id, link.kalshiMarketId))
    .limit(1);
  const event = km?.eventId
    ? (await db().select().from(events).where(eq(events.id, km.eventId)).limit(1))[0]
    : null;
  const feeCat = feeCategoryFor(event?.category);

  const snaps = await latestSnapshots([link.kalshiMarketId, link.polymarketMarketId]);
  const ks = snaps.get(link.kalshiMarketId) ?? null;
  const ps = snaps.get(link.polymarketMarketId) ?? null;

  const exitKalshi = trade.kalshiSide ? legBid(trade.kalshiSide, ks) : null;
  const exitPoly = trade.polySide ? legBid(trade.polySide, ps) : null;
  if ((trade.kalshiSide && exitKalshi === null) || (trade.polySide && exitPoly === null)) {
    throw new Error("No current bid to close against — run the snapshot job first");
  }

  const exitFeesUsd =
    (exitKalshi !== null ? kalshiTakerFeePerShare(exitKalshi, feeCat) * trade.shares : 0) +
    (exitPoly !== null
      ? polymarketTakerFeePerShare(exitPoly, feeCat, { isSell: true }) * trade.shares
      : 0);
  const proceeds =
    ((exitKalshi ?? 0) + (exitPoly ?? 0)) * trade.shares - exitFeesUsd;

  await db()
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
    .where(eq(paperTrades.id, tradeId));
  revalidatePath("/paper");
}

export async function settlePaperTrade(formData: FormData) {
  if (!(await hasPaperAccess(formData.get("token") as string | null))) {
    throw new Error("Unauthorized");
  }
  const tradeId = String(formData.get("tradeId") ?? "");
  const outcome = String(formData.get("outcome") ?? ""); // 'yes' | 'no', canonical
  if (outcome !== "yes" && outcome !== "no") throw new Error("Bad outcome");

  const [trade] = await db()
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.id, tradeId))
    .limit(1);
  if (!trade || trade.status !== "open") throw new Error("No such open trade");

  const [link] = await db()
    .select()
    .from(marketLinks)
    .where(eq(marketLinks.id, trade.marketLinkId))
    .limit(1);
  if (!link) throw new Error("Market link missing");

  const v = settlementValuePerShare(trade, outcome === "yes", link.outcomeInverted);
  const payout = ((v.kalshi ?? 0) + (v.poly ?? 0)) * trade.shares;

  await db()
    .update(paperTrades)
    .set({
      status: "closed",
      closedAt: new Date(),
      exitKalshi: v.kalshi,
      exitPoly: v.poly,
      exitFeesUsd: 0,
      realizedPnlUsd: payout - tradeCostUsd(trade),
      closeReason: outcome === "yes" ? "settled_yes" : "settled_no",
    })
    .where(eq(paperTrades.id, tradeId));
  revalidatePath("/paper");
}

export async function deletePaperTrade(formData: FormData) {
  if (!(await hasPaperAccess(formData.get("token") as string | null))) {
    throw new Error("Unauthorized");
  }
  const tradeId = String(formData.get("tradeId") ?? "");
  await db().delete(paperTrades).where(eq(paperTrades.id, tradeId));
  revalidatePath("/paper");
}
