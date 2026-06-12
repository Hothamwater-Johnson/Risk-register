import type { Metadata } from "next";
import { desc, inArray } from "drizzle-orm";
import { isAdmin } from "@/lib/config";
import { db } from "@/lib/db/client";
import { paperTrades, profiles } from "@/lib/db/schema";
import { PAPER_STARTING_BANKROLL } from "@/lib/paper";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Testers", robots: "noindex" };

type Props = { searchParams: Promise<{ token?: string }> };

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const when = (d: Date | null) =>
  d ? d.toISOString().slice(0, 16).replace("T", " ") : "—";

export default async function TestersPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!isAdmin(token)) {
    return (
      <p className="py-20 text-center text-sm text-muted">
        Add ?token=ADMIN_TOKEN to the URL.
      </p>
    );
  }

  const rows = await db()
    .select()
    .from(profiles)
    .orderBy(desc(profiles.createdAt));

  // One pass over every tester's trades; cheap at this scale (a few people).
  const ids = rows.map((p) => p.id);
  const trades = ids.length
    ? await db()
        .select()
        .from(paperTrades)
        .where(inArray(paperTrades.profileId, ids))
    : [];

  const byProfile = new Map<
    string,
    { open: number; closed: number; realized: number; last: Date | null }
  >();
  for (const t of trades) {
    if (!t.profileId) continue;
    const agg =
      byProfile.get(t.profileId) ??
      { open: 0, closed: 0, realized: 0, last: null as Date | null };
    if (t.status === "open") agg.open += 1;
    else {
      agg.closed += 1;
      agg.realized += t.realizedPnlUsd ?? 0;
    }
    const stamp = t.closedAt ?? t.openedAt ?? null;
    if (stamp && (!agg.last || stamp > agg.last)) agg.last = stamp;
    byProfile.set(t.profileId, agg);
  }

  const activeCount = [...byProfile.values()].filter(
    (a) => a.open + a.closed > 0,
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold tracking-tight">Testers</h1>
        <span className="text-sm text-muted">
          {rows.length} signed up · {activeCount} have traded
        </span>
      </div>

      <div className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
        {rows.length === 0 && (
          <p className="px-4 py-6 text-center text-muted">
            No one has registered yet. Share /paper plus the invite code.
          </p>
        )}
        {rows.map((p) => {
          const agg = byProfile.get(p.id);
          const open = agg?.open ?? 0;
          const closed = agg?.closed ?? 0;
          const realized = agg?.realized ?? 0;
          const equity = PAPER_STARTING_BANKROLL + realized;
          return (
            <div key={p.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">
                  {p.displayName || p.email}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted">
                  joined {when(p.createdAt)}
                </span>
              </div>
              {p.displayName && (
                <p className="truncate text-xs text-muted">{p.email}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                <span>{open} open</span>
                <span>{closed} closed</span>
                <span>
                  realized{" "}
                  <span
                    className={`font-mono ${
                      realized > 0
                        ? "text-positive"
                        : realized < 0
                          ? "text-negative"
                          : ""
                    }`}
                  >
                    {realized >= 0 ? "+" : ""}
                    {usd(realized)}
                  </span>
                </span>
                <span>
                  equity <span className="font-mono">{usd(equity)}</span>
                </span>
                <span>last active {when(agg?.last ?? null)}</span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted">
        Equity is the closed-trade realized P&amp;L on top of each tester&apos;s{" "}
        {usd(PAPER_STARTING_BANKROLL)} starting bankroll; open positions
        aren&apos;t marked here. Your own owner book isn&apos;t a profile, so it
        doesn&apos;t appear in this list.
      </p>
    </div>
  );
}
