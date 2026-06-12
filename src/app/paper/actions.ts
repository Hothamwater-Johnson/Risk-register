"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
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
  profiles,
  type PaperSide,
  type PaperTrade,
} from "@/lib/db/schema";
import { describeFill } from "@/lib/explain/copy";
import {
  getPaperTradeViews,
  legBid,
  paperStats,
  settleOpenTrade,
  tradeCostUsd,
} from "@/lib/paper";
import {
  getPaperIdentity,
  identityProfileId,
  inviteCodeOk,
  PAPER_COOKIE,
  PROFILE_COOKIE,
  sealProfileId,
  type PaperIdentity,
} from "@/lib/profile";
import { latestSnapshots, quoteFromSnapshot } from "@/lib/queries";

/**
 * All fills are computed server-side from the latest snapshots at submit
 * time — client-displayed prices are never trusted. That means the fill you
 * get can differ from the number you clicked, which is exactly the slippage
 * a real order would see between glance and click.
 *
 * Mutating actions return state for useActionState instead of throwing:
 * production masks thrown server-action errors, so a throw is a blank shrug
 * to the user — the exact failure mode that caused five duplicate opens.
 */

const cookieOpts = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 365,
} as const;

export async function paperLogin(formData: FormData) {
  // Trim: phone copy-paste loves trailing whitespace/newlines.
  const token = String(formData.get("token") ?? "").trim();
  if (!isAdmin(token)) redirect("/paper?denied=1");
  const store = await cookies();
  store.set(PAPER_COOKIE, token, cookieOpts);
  revalidatePath("/paper");
}

export async function paperLogout() {
  const store = await cookies();
  store.delete(PAPER_COOKIE);
  store.delete(PROFILE_COOKIE);
  revalidatePath("/paper");
}

export type SignupState = { status: "idle" } | { status: "error"; message: string };

const SignupInput = z.object({
  email: z.email("That email doesn't look right — check it and try again."),
  inviteCode: z.string().min(1, "The invite code is required."),
  displayName: z.string().max(80).optional(),
});

/** One form does sign-up AND sign-in: an existing email just gets its cookie back. */
export async function profileSignup(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const parsed = SignupInput.safeParse({
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    inviteCode: String(formData.get("inviteCode") ?? "").trim(),
    displayName: String(formData.get("displayName") ?? "").trim() || undefined,
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the form and try again.",
    };
  }
  if (!process.env.INVITE_CODE || !process.env.ADMIN_TOKEN) {
    return {
      status: "error",
      message: "Sign-ups aren't switched on yet — ask the owner to set an invite code.",
    };
  }
  if (!inviteCodeOk(parsed.data.inviteCode)) {
    return {
      status: "error",
      message: "That invite code didn't match — check for stray spaces and try again.",
    };
  }

  const [profile] = await db()
    .insert(profiles)
    .values({
      email: parsed.data.email,
      displayName: parsed.data.displayName ?? null,
    })
    .onConflictDoUpdate({
      target: profiles.email,
      // No-op update so RETURNING gives us the existing row on sign-in.
      set: { email: parsed.data.email },
    })
    .returning();

  const sealed = sealProfileId(profile.id);
  if (!sealed) {
    return { status: "error", message: "Sign-ups aren't configured on this server." };
  }
  const store = await cookies();
  store.set(PROFILE_COOKIE, sealed, cookieOpts);
  revalidatePath("/paper");
  return { status: "idle" };
}

export type OpenTradeMode =
  | "arb"
  | "yes_kalshi"
  | "no_kalshi"
  | "yes_polymarket"
  | "no_polymarket";

export type OpenTradeState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "opened" | "duplicate"; message: string; usedKey: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function openPaperTrade(
  _prev: OpenTradeState,
  formData: FormData,
): Promise<OpenTradeState> {
  const identity = await getPaperIdentity();
  if (!identity) return { status: "error", message: "You're not signed in — unlock paper trading first." };

  const linkId = String(formData.get("linkId") ?? "");
  const mode = String(formData.get("mode") ?? "") as OpenTradeMode;
  const shares = Number(formData.get("shares") ?? 0);
  const thesis = String(formData.get("thesis") ?? "").trim() || null;
  const idemKey = String(formData.get("idempotencyKey") ?? "");
  if (!UUID_RE.test(idemKey)) {
    return { status: "error", message: "This form went stale — reload the page and try again." };
  }
  if (!Number.isFinite(shares) || shares <= 0 || shares > 100_000) {
    return { status: "error", message: "Shares must be a positive number (100,000 max)." };
  }

  const profileId = identityProfileId(identity);

  // Same tap twice (double-click, back button, impatient retry)? The unique
  // index on idempotency_key means only the first insert lands; here we catch
  // the retry early to echo the original fill instead of inserting again.
  const [existing] = await db()
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.idempotencyKey, idemKey))
    .limit(1);
  if (existing) return duplicateState(existing, idemKey);

  const [link] = await db()
    .select()
    .from(marketLinks)
    .where(eq(marketLinks.id, linkId))
    .limit(1);
  if (!link) return { status: "error", message: "Unknown market link — reload the page." };

  const [[km], [pm]] = await Promise.all([
    db().select().from(markets).where(eq(markets.id, link.kalshiMarketId)).limit(1),
    db().select().from(markets).where(eq(markets.id, link.polymarketMarketId)).limit(1),
  ]);
  if (!km || !pm) return { status: "error", message: "Markets missing for this link." };

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
    if (!arb) return { status: "error", message: "No arb is currently available on this pair — prices moved." };
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
    if (kalshiEntry === null) return { status: "error", message: "No current Kalshi ask to fill at." };
  } else if (mode === "yes_polymarket" || mode === "no_polymarket") {
    polySide = flip(mode === "yes_polymarket" ? "yes" : "no");
    polyEntry = polySide === "yes" ? (ps?.yesAsk ?? null) : (ps?.noAsk ?? null);
    if (polyEntry === null) return { status: "error", message: "No current Polymarket ask to fill at." };
  } else {
    return { status: "error", message: "Unknown trade mode." };
  }

  const entryFeesUsd =
    (kalshiEntry !== null ? kalshiTakerFeePerShare(kalshiEntry, feeCat) * shares : 0) +
    (polyEntry !== null ? polymarketTakerFeePerShare(polyEntry, feeCat) * shares : 0);
  const costUsd =
    ((kalshiEntry ?? 0) + (polyEntry ?? 0)) * shares + entryFeesUsd;

  const stats = paperStats(await getPaperTradeViews(profileId));
  if (costUsd > stats.cashUsd) {
    return {
      status: "error",
      message: `This costs $${costUsd.toFixed(2)} but only $${stats.cashUsd.toFixed(2)} paper cash is free.`,
    };
  }

  const inserted = await db()
    .insert(paperTrades)
    .values({
      marketLinkId: link.id,
      profileId,
      idempotencyKey: idemKey,
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
    })
    .onConflictDoNothing({ target: paperTrades.idempotencyKey })
    .returning();

  revalidatePath("/paper");

  if (inserted.length === 0) {
    // Lost a race with our own retry: the key landed between the early check
    // and this insert. The position exists exactly once — report it.
    const [row] = await db()
      .select()
      .from(paperTrades)
      .where(eq(paperTrades.idempotencyKey, idemKey))
      .limit(1);
    return row
      ? duplicateState(row, idemKey)
      : { status: "error", message: "Something raced — check your /paper book before retrying." };
  }

  const t = inserted[0];
  return {
    status: "opened",
    usedKey: idemKey,
    message: describeFill({
      kalshiSide: t.kalshiSide,
      kalshiEntry: t.kalshiEntry,
      polySide: t.polySide,
      polyEntry: t.polyEntry,
      shares: t.shares,
      entryFeesUsd: t.entryFeesUsd,
      costUsd: tradeCostUsd(t),
    }),
  };
}

function duplicateState(t: PaperTrade, usedKey: string): OpenTradeState {
  return {
    status: "duplicate",
    usedKey,
    message: `Already open — this tap didn't create a new position. ${describeFill({
      kalshiSide: t.kalshiSide,
      kalshiEntry: t.kalshiEntry,
      polySide: t.polySide,
      polyEntry: t.polyEntry,
      shares: t.shares,
      entryFeesUsd: t.entryFeesUsd,
      costUsd: tradeCostUsd(t),
    })}`,
  };
}

/** Admins may manage any trade; testers only their own. */
function ownsTrade(identity: PaperIdentity, trade: PaperTrade): boolean {
  return identity.kind === "admin" || trade.profileId === identity.profile.id;
}

async function getOwnedOpenTrade(
  tradeId: string,
): Promise<{ trade: PaperTrade; identity: PaperIdentity } | null> {
  const identity = await getPaperIdentity();
  if (!identity) return null;
  const [trade] = await db()
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.id, tradeId))
    .limit(1);
  if (!trade || trade.status !== "open" || !ownsTrade(identity, trade)) return null;
  return { trade, identity };
}

export async function closePaperTrade(formData: FormData) {
  const owned = await getOwnedOpenTrade(String(formData.get("tradeId") ?? ""));
  if (!owned) throw new Error("No such open trade");
  const { trade } = owned;

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
    .where(and(eq(paperTrades.id, trade.id), eq(paperTrades.status, "open")));
  revalidatePath("/paper");
}

export async function settlePaperTrade(formData: FormData) {
  const outcome = String(formData.get("outcome") ?? ""); // 'yes' | 'no', canonical
  if (outcome !== "yes" && outcome !== "no") throw new Error("Bad outcome");
  const owned = await getOwnedOpenTrade(String(formData.get("tradeId") ?? ""));
  if (!owned) throw new Error("No such open trade");
  const { trade } = owned;

  const [link] = await db()
    .select()
    .from(marketLinks)
    .where(eq(marketLinks.id, trade.marketLinkId))
    .limit(1);
  if (!link) throw new Error("Market link missing");

  await settleOpenTrade(trade, link.outcomeInverted, outcome === "yes");
  revalidatePath("/paper");
}

export async function deletePaperTrade(formData: FormData) {
  const identity = await getPaperIdentity();
  if (!identity) throw new Error("Unauthorized");
  const tradeId = String(formData.get("tradeId") ?? "");
  const [trade] = await db()
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.id, tradeId))
    .limit(1);
  if (!trade || !ownsTrade(identity, trade)) throw new Error("No such trade");
  await db().delete(paperTrades).where(eq(paperTrades.id, tradeId));
  revalidatePath("/paper");
}
