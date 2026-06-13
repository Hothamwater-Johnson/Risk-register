import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import {
  AUTO_TRADER_CLOSE_RULES_DIFFER,
  AUTO_TRADER_ENABLED,
  AUTO_TRADER_MAX_OPEN,
  AUTO_TRADER_MAX_PER_PAIR,
  AUTO_TRADER_MIN_EDGE,
  AUTO_TRADER_STAKE_USD,
  AUTO_TRADER_STOP_USD,
  AUTO_TRADER_TAKE_PROFIT_USD,
  isAdmin,
} from "@/lib/config";
import { db } from "@/lib/db/client";
import { syncRuns } from "@/lib/db/schema";
import { ensureBotProfileId, getPaperTradeViews, paperStats } from "@/lib/paper";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auto-trader", robots: "noindex" };

type Props = { searchParams: Promise<{ token?: string }> };

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const when = (d: Date | null) =>
  d ? d.toISOString().slice(0, 16).replace("T", " ") : "—";

const signed = (n: number) =>
  `${n >= 0 ? "+" : ""}${usd(n)}`;

const pnlClass = (n: number) =>
  n > 0 ? "text-positive" : n < 0 ? "text-negative" : "";

export default async function AutoTraderPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!isAdmin(token)) {
    return (
      <p className="py-20 text-center text-sm text-muted">
        Add ?token=ADMIN_TOKEN to the URL.
      </p>
    );
  }

  const botProfileId = await ensureBotProfileId();
  const [views, lastRun] = await Promise.all([
    getPaperTradeViews(botProfileId),
    db()
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.job, "auto-trade"))
      .orderBy(desc(syncRuns.startedAt))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);
  const stats = paperStats(views);
  const recent = views.slice(0, 30);

  const metrics: { label: string; value: string; cls?: string }[] = [
    { label: "Equity", value: usd(stats.equityUsd) },
    { label: "Cash free", value: usd(stats.cashUsd) },
    {
      label: "Unrealized",
      value: signed(stats.unrealizedPnlUsd),
      cls: pnlClass(stats.unrealizedPnlUsd),
    },
    {
      label: "Realized",
      value: signed(stats.realizedPnlUsd),
      cls: pnlClass(stats.realizedPnlUsd),
    },
    {
      label: "Capture ratio",
      value:
        stats.captureRatio === null
          ? "—"
          : `${(stats.captureRatio * 100).toFixed(0)}%`,
    },
    {
      label: "Open / closed",
      value: `${views.length - stats.closedCount} / ${stats.closedCount}`,
    },
  ];

  const config: [string, string][] = [
    ["Enabled", AUTO_TRADER_ENABLED ? "yes" : "no (set AUTO_TRADER_ENABLED=1)"],
    ["Min net edge", `${(AUTO_TRADER_MIN_EDGE * 100).toFixed(2)}¢/share`],
    ["Stake / position", usd(AUTO_TRADER_STAKE_USD)],
    ["Max open", String(AUTO_TRADER_MAX_OPEN)],
    ["Max per pair", String(AUTO_TRADER_MAX_PER_PAIR)],
    ["Take profit", usd(AUTO_TRADER_TAKE_PROFIT_USD)],
    ["Stop loss", `−${usd(AUTO_TRADER_STOP_USD)}`],
    ["Close on rules-differ", AUTO_TRADER_CLOSE_RULES_DIFFER ? "yes" : "no"],
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold tracking-tight">Auto-trader</h1>
        <span className="text-sm text-muted">paper · admin-only · owner book separate</span>
      </div>

      {/* Performance */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border text-sm sm:grid-cols-3">
        {metrics.map((m) => (
          <div key={m.label} className="bg-card px-4 py-3">
            <div className="text-xs text-muted">{m.label}</div>
            <div className={`mt-0.5 font-mono ${m.cls ?? ""}`}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* Config + last run */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4 text-xs">
          <div className="mb-2 font-semibold">Config</div>
          <dl className="space-y-1">
            {config.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted">{k}</dt>
                <dd className="font-mono">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 text-xs">
          <div className="mb-2 font-semibold">Last run</div>
          {lastRun ? (
            <div className="space-y-1">
              <div className="flex justify-between gap-3">
                <span className="text-muted">when</span>
                <span className="font-mono">{when(lastRun.startedAt)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted">status</span>
                <span className="font-mono">
                  {lastRun.ok === true ? "✅ ok" : lastRun.ok === false ? "❌ error" : "⏳ running"}
                </span>
              </div>
              {lastRun.error && <p className="text-negative">{lastRun.error}</p>}
              {lastRun.stats != null && (
                <p className="break-all font-mono text-muted">
                  {JSON.stringify(lastRun.stats)}
                </p>
              )}
            </div>
          ) : (
            <p className="text-muted">
              No runs yet. Trigger /api/jobs/auto-trade with the cron secret.
            </p>
          )}
        </div>
      </div>

      {/* Recent trades */}
      <div className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
        {recent.length === 0 && (
          <p className="px-4 py-6 text-center text-muted">
            The bot hasn&apos;t opened anything yet.
          </p>
        )}
        {recent.map((v) => {
          const t = v.trade;
          const title =
            v.event?.title ?? v.kalshiMarket?.question ?? t.marketLinkId;
          const pnl =
            t.status === "closed" ? (t.realizedPnlUsd ?? 0) : v.mark.unrealizedPnlUsd;
          const legs = [
            t.kalshiSide
              ? `K ${t.kalshiSide} @ ${((t.kalshiEntry ?? 0) * 100).toFixed(0)}¢`
              : null,
            t.polySide
              ? `P ${t.polySide} @ ${((t.polyEntry ?? 0) * 100).toFixed(0)}¢`
              : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div key={t.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{title}</span>
                <span className="shrink-0 font-mono text-xs text-muted">
                  {t.status} · {when(t.closedAt ?? t.openedAt ?? null)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
                <span className="font-mono">{legs || "—"}</span>
                <span>{t.shares.toLocaleString()} sh</span>
                <span>cost {usd(v.costUsd)}</span>
                {t.expectedEdge !== null && (
                  <span>exp edge {(t.expectedEdge * 100).toFixed(2)}¢</span>
                )}
                {t.closeReason && <span>{t.closeReason}</span>}
                {pnl !== null && (
                  <span>
                    {t.status === "closed" ? "P&L" : "unreal"}{" "}
                    <span className={`font-mono ${pnlClass(pnl)}`}>{signed(pnl)}</span>
                  </span>
                )}
                {v.mark.stale && t.status === "open" && (
                  <span className="text-muted">(no quote)</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted">
        Capture ratio is realized P&amp;L over expected edge on closed arbs — the
        honesty metric. The bot holds clean arbs to settlement and only closes
        early on take-profit, stop-loss, or a positive mark on a rules-differ
        pair. This book is the reserved bot profile, separate from your owner book.
      </p>
    </div>
  );
}
