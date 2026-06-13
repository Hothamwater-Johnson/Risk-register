import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import {
  AUTO_TRADER_CLOSE_RULES_DIFFER,
  AUTO_TRADER_ENABLED,
  AUTO_TRADER_MAX_OPEN,
  AUTO_TRADER_MAX_PER_PAIR,
  AUTO_TRADER_MIN_EDGE,
  AUTO_TRADER_PASSWORD,
  AUTO_TRADER_STAKE_USD,
  AUTO_TRADER_STOP_USD,
  AUTO_TRADER_TAKE_PROFIT_USD,
} from "@/lib/config";
import { db } from "@/lib/db/client";
import { syncRuns } from "@/lib/db/schema";
import {
  ensureBotProfileId,
  getPaperTradeViews,
  hasPaperAccess,
  paperStats,
} from "@/lib/paper";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auto-trader", robots: "noindex" };

type Props = { searchParams: Promise<{ token?: string; denied?: string }> };

const ACCESS_COOKIE = "at_access";
const cookieOpts = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 365,
} as const;

/** Granted by the simple password cookie OR the existing ADMIN_TOKEN paths. */
async function hasAutoTraderAccess(token?: string): Promise<boolean> {
  if (await hasPaperAccess(token)) return true;
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value === AUTO_TRADER_PASSWORD;
}

async function unlock(formData: FormData) {
  "use server";
  const pw = String(formData.get("password") ?? "").trim();
  if (pw !== AUTO_TRADER_PASSWORD) redirect("/admin/auto-trader?denied=1");
  const store = await cookies();
  store.set(ACCESS_COOKIE, pw, cookieOpts);
  redirect("/admin/auto-trader");
}

async function lock() {
  "use server";
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  revalidatePath("/admin/auto-trader");
}

function LockScreen({ denied }: { denied?: string }) {
  return (
    <div className="mx-auto max-w-xs space-y-4 py-16">
      <div className="text-center">
        <h1 className="text-xl font-bold tracking-tight">Auto-trader</h1>
        <p className="mt-1 text-sm text-muted">Enter the password to view the bot.</p>
      </div>
      <form action={unlock} className="space-y-2">
        <input
          type="password"
          name="password"
          autoFocus
          placeholder="Password"
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-background"
        >
          Unlock
        </button>
        {denied && (
          <p className="text-center text-xs text-negative">
            Wrong password — try again.
          </p>
        )}
      </form>
    </div>
  );
}

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const when = (d: Date | null) =>
  d ? d.toISOString().slice(0, 16).replace("T", " ") : "—";

const signed = (n: number) =>
  `${n >= 0 ? "+" : ""}${usd(n)}`;

const pnlClass = (n: number) =>
  n > 0 ? "text-positive" : n < 0 ? "text-negative" : "";

export default async function AutoTraderPage({ searchParams }: Props) {
  const { token, denied } = await searchParams;
  if (!(await hasAutoTraderAccess(token))) {
    return <LockScreen denied={denied} />;
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
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Auto-trader</h1>
        <div className="flex shrink-0 items-baseline gap-3 text-sm text-muted">
          <span className="hidden sm:inline">paper · owner book separate</span>
          <form action={lock}>
            <button type="submit" className="hover:text-foreground">
              Lock
            </button>
          </form>
        </div>
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
