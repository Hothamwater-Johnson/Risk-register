import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { desc, eq, not, sql } from "drizzle-orm";
import { isAdmin } from "@/lib/config";
import { db } from "@/lib/db/client";
import {
  eventMatches,
  events,
  marketLinks,
  markets,
} from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { cents } from "@/lib/explain/copy";
import { latestSnapshots, platformUrl } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Match review", robots: "noindex" };

type Props = { searchParams: Promise<{ token?: string }> };

async function reviewMatch(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  if (!isAdmin(token)) throw new Error("Unauthorized");

  const matchId = String(formData.get("matchId") ?? "");
  const action = String(formData.get("action") ?? "");

  if (action === "confirm" || action === "reject") {
    const status = action === "confirm" ? "confirmed" : "rejected";
    await db()
      .update(eventMatches)
      .set({ status, method: "manual", reviewedAt: new Date() })
      .where(eq(eventMatches.id, matchId));
    await db()
      .update(marketLinks)
      .set({ status })
      .where(eq(marketLinks.eventMatchId, matchId));
  } else if (action === "invert") {
    const linkId = String(formData.get("linkId") ?? "");
    await db()
      .update(marketLinks)
      .set({ outcomeInverted: not(marketLinks.outcomeInverted) })
      .where(eq(marketLinks.id, linkId));
  }
  revalidatePath("/admin/matches");
}

export default async function MatchReviewPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!isAdmin(token)) {
    return (
      <p className="py-20 text-center text-sm text-muted">
        Add ?token=ADMIN_TOKEN to the URL.
      </p>
    );
  }

  const [queue, [{ total }]] = await Promise.all([
    db()
      .select()
      .from(eventMatches)
      .where(eq(eventMatches.status, "candidate"))
      .orderBy(desc(eventMatches.confidence))
      .limit(25),
    db()
      .select({ total: sql<number>`count(*)::int` })
      .from(eventMatches)
      .where(eq(eventMatches.status, "candidate")),
  ]);

  const eventIds = [
    ...new Set(queue.flatMap((m) => [m.kalshiEventId, m.polymarketEventId])),
  ];
  const matchIds = queue.map((m) => m.id);
  const [eventRows, linkRows] = await Promise.all([
    eventIds.length
      ? db().select().from(events).where(inArray(events.id, eventIds))
      : Promise.resolve([]),
    matchIds.length
      ? db().select().from(marketLinks).where(inArray(marketLinks.eventMatchId, matchIds))
      : Promise.resolve([]),
  ]);
  const allMarketIds = [
    ...new Set(linkRows.flatMap((l) => [l.kalshiMarketId, l.polymarketMarketId])),
  ];
  const [marketList, snaps] = await Promise.all([
    allMarketIds.length
      ? db().select().from(markets).where(inArray(markets.id, allMarketIds))
      : Promise.resolve([]),
    latestSnapshots(allMarketIds),
  ]);
  const eventById = new Map(eventRows.map((e) => [e.id, e]));
  const marketById = new Map(marketList.map((m) => [m.id, m]));
  const midOf = (marketId: string): number | null => {
    const s = snaps.get(marketId);
    return s?.mid ?? s?.lastPrice ?? null;
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold tracking-tight">
        Match review queue{" "}
        <span className="text-sm font-normal text-muted">
          (showing {queue.length} of {total})
        </span>
      </h1>

      {queue.length === 0 && (
        <p className="text-sm text-muted">Queue is empty. Nice.</p>
      )}

      {queue.map((m) => {
        const ke = eventById.get(m.kalshiEventId);
        const pe = eventById.get(m.polymarketEventId);
        const breakdown = m.scoreBreakdown as {
          heuristic?: { total?: number };
          llm?: { reason?: string };
        } | null;
        const links = linkRows.filter((l) => l.eventMatchId === m.id);
        const firstKalshiMarket = links[0]
          ? marketById.get(links[0].kalshiMarketId)
          : undefined;
        const firstPolyMarket = links[0]
          ? marketById.get(links[0].polymarketMarketId)
          : undefined;
        return (
          <div key={m.id} className="rounded-xl border border-border bg-card p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold text-positive">KALSHI</p>
                <p className="mt-1 text-sm font-medium">
                  {firstKalshiMarket && ke ? (
                    <a
                      href={platformUrl(firstKalshiMarket, ke)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {ke.title} ↗
                    </a>
                  ) : (
                    ke?.title
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  closes {ke?.closeTime?.toLocaleDateString() ?? "?"}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold text-accent">POLYMARKET</p>
                <p className="mt-1 text-sm font-medium">
                  {firstPolyMarket && pe ? (
                    <a
                      href={platformUrl(firstPolyMarket, pe)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      {pe.title} ↗
                    </a>
                  ) : (
                    pe?.title
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  closes {pe?.closeTime?.toLocaleDateString() ?? "?"}
                </p>
              </div>
            </div>

            <p className="mt-3 text-xs text-muted">
              LLM {Math.round((m.confidence ?? 0) * 100)}% · heuristic{" "}
              {Math.round((breakdown?.heuristic?.total ?? 0) * 100)}% ·{" "}
              {breakdown?.llm?.reason ?? "no reason given"}
            </p>

            {links.length > 0 && (
              <div className="mt-3 space-y-1">
                {links.map((l) => {
                  const kMid = midOf(l.kalshiMarketId);
                  const pMidRaw = midOf(l.polymarketMarketId);
                  // Show the Polymarket price in canonical (Kalshi-question)
                  // terms so a glance at the gap means something.
                  const pMid =
                    pMidRaw !== null && l.outcomeInverted ? 1 - pMidRaw : pMidRaw;
                  const gap =
                    kMid !== null && pMid !== null ? Math.abs(kMid - pMid) : null;
                  return (
                  <div
                    key={l.id}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate text-muted">
                      {marketById.get(l.kalshiMarketId)?.outcomeLabel ??
                        marketById.get(l.kalshiMarketId)?.question}{" "}
                      ↔{" "}
                      {marketById.get(l.polymarketMarketId)?.outcomeLabel ??
                        marketById.get(l.polymarketMarketId)?.question}
                      {l.outcomeInverted && " (inverted)"}
                    </span>
                    <span className="shrink-0 font-mono text-muted">
                      {kMid !== null ? cents(kMid) : "—"} vs{" "}
                      {pMid !== null ? cents(pMid) : "—"}
                      {gap !== null && (
                        <strong
                          className={gap >= 0.05 ? "text-amber-600 dark:text-amber-400" : ""}
                        >
                          {" "}Δ{cents(gap)}
                        </strong>
                      )}
                    </span>
                    <form action={reviewMatch}>
                      <input type="hidden" name="token" value={token} />
                      <input type="hidden" name="matchId" value={m.id} />
                      <input type="hidden" name="linkId" value={l.id} />
                      <input type="hidden" name="action" value="invert" />
                      <button className="shrink-0 rounded border border-border px-2 py-0.5 text-muted hover:text-foreground">
                        invert
                      </button>
                    </form>
                  </div>
                  );
                })}
              </div>
            )}

            <div className="mt-4 flex gap-2">
              <form action={reviewMatch} className="flex-1">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="matchId" value={m.id} />
                <input type="hidden" name="action" value="confirm" />
                <button className="w-full rounded-lg bg-positive px-4 py-2 text-sm font-semibold text-white">
                  Confirm
                </button>
              </form>
              <form action={reviewMatch} className="flex-1">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="matchId" value={m.id} />
                <input type="hidden" name="action" value="reject" />
                <button className="w-full rounded-lg bg-negative px-4 py-2 text-sm font-semibold text-white">
                  Reject
                </button>
              </form>
            </div>
          </div>
        );
      })}
    </div>
  );
}
