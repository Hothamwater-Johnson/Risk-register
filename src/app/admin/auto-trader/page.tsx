import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import {
  AUTO_TRADER_CLOSE_RULES_DIFFER,
  AUTO_TRADER_MAX_OPEN,
  AUTO_TRADER_MAX_PER_PAIR,
  AUTO_TRADER_MIN_EDGE,
  AUTO_TRADER_PASSWORD,
  AUTO_TRADER_STAKE_USD,
  AUTO_TRADER_STOP_USD,
  AUTO_TRADER_TAKE_PROFIT_USD,
} from "@/lib/config";
import {
  AT_ACCESS_COOKIE,
  atCookieOpts,
  clearSession,
  getAutoTraderState,
  hasAutoTraderAccess,
  listArchivedSessions,
  pauseAutoTrader,
  startAutoTrader,
} from "@/lib/autoTrader";
import { db } from "@/lib/db/client";
import { syncRuns, type TradingSession } from "@/lib/db/schema";
import {
  ensureBotProfileId,
  getPaperTradeViews,
  paperStats,
  type PaperStats,
} from "@/lib/paper";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auto-trader", robots: "noindex" };

type Props = {
  searchParams: Promise<{
    token?: string;
    denied?: string;
    confirm?: string;
    cleared?: string;
    migrate?: string;
  }>;
};

// ---- access / session actions (server) ----

async function unlock(formData: FormData) {
  "use server";
  const pw = String(formData.get("password") ?? "").trim();
  if (pw !== AUTO_TRADER_PASSWORD) redirect("/admin/auto-trader?denied=1");
  const store = await cookies();
  store.set(AT_ACCESS_COOKIE, pw, atCookieOpts);
  redirect("/admin/auto-trader");
}

async function lock() {
  "use server";
  const store = await cookies();
  store.delete(AT_ACCESS_COOKIE);
  revalidatePath("/admin/auto-trader");
}

async function startAction() {
  "use server";
  if (!(await hasAutoTraderAccess())) throw new Error("Unauthorized");
  await startAutoTrader();
  revalidatePath("/admin/auto-trader");
}

async function pauseAction() {
  "use server";
  if (!(await hasAutoTraderAccess())) throw new Error("Unauthorized");
  await pauseAutoTrader();
  revalidatePath("/admin/auto-trader");
}

async function clearAction() {
  "use server";
  if (!(await hasAutoTraderAccess())) throw new Error("Unauthorized");
  const res = await clearSession();
  revalidatePath("/admin/auto-trader");
  redirect(res.ok ? "/admin/auto-trader?cleared=1" : "/admin/auto-trader?migrate=1");
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

// ---- formatting ----

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const when = (d: Date | null) =>
  d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—";

const signed = (n: number) => `${n >= 0 ? "+" : ""}${usd(n)}`;

const pnlClass = (n: number) =>
  n > 0 ? "text-positive" : n < 0 ? "text-negative" : "";

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(0)}%`;

export default async function AutoTraderPage({ searchParams }: Props) {
  const { token, denied, confirm, cleared, migrate } = await searchParams;
  if (!(await hasAutoTraderAccess(token))) {
    return <LockScreen denied={denied} />;
  }

  const botProfileId = await ensureBotProfileId();
  const [state, views, archived, lastRun] = await Promise.all([
    getAutoTraderState(),
    getPaperTradeViews(botProfileId),
    listArchivedSessions(25),
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

  const status = state.migrationNeeded
    ? "migration needed"
    : (state.session?.status ?? "no session");
  const statusCls = state.running
    ? "text-positive"
    : status === "migration needed"
      ? "text-negative"
      : "text-muted";

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
    { label: "Capture ratio", value: pct(stats.captureRatio) },
    {
      label: "Open / closed",
      value: `${views.length - stats.closedCount} / ${stats.closedCount}`,
    },
  ];

  const config: [string, string][] = [
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

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
        <span className="flex items-center gap-2">
          <span className="text-xs text-muted">Status</span>
          <span className={`font-semibold ${statusCls}`}>{status}</span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!state.migrationNeeded &&
            (state.running ? (
              <form action={pauseAction}>
                <button
                  type="submit"
                  className="rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-background"
                >
                  Stop
                </button>
              </form>
            ) : (
              <form action={startAction}>
                <button
                  type="submit"
                  className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-background"
                >
                  Start
                </button>
              </form>
            ))}
          <a
            href="/admin/auto-trader/export"
            className="rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-background"
          >
            Download CSV
          </a>
          {!state.migrationNeeded && (
            <a
              href="/admin/auto-trader?confirm=clear"
              className="rounded-lg border border-negative/40 px-3 py-1.5 font-medium text-negative hover:bg-negative/10"
            >
              Clear session
            </a>
          )}
        </div>
      </div>

      {state.migrationNeeded && (
        <p className="rounded-xl border border-negative/40 bg-negative/10 px-4 py-3 text-xs text-negative">
          The <code>trading_sessions</code> table isn&apos;t migrated yet. Run{" "}
          <code>drizzle/0003_trading_sessions.sql</code> on the database to enable
          start/stop and session logging. Until then the bot follows the{" "}
          <code>AUTO_TRADER_ENABLED</code> env flag.
        </p>
      )}
      {cleared && (
        <p className="rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted">
          Session cleared and logged. The new session is paused — press{" "}
          <strong className="text-foreground">Start</strong> to trade again, and
          grab the archived CSV below.
        </p>
      )}
      {migrate && (
        <p className="rounded-xl border border-negative/40 bg-negative/10 px-4 py-3 text-xs text-negative">
          Couldn&apos;t clear — the <code>trading_sessions</code> table isn&apos;t
          migrated yet.
        </p>
      )}

      {/* Clear confirmation */}
      {confirm === "clear" && !state.migrationNeeded && (
        <div className="space-y-2 rounded-xl border border-negative/40 bg-negative/10 px-4 py-3 text-sm">
          <p className="font-medium">
            Clear and reset the trading session?
          </p>
          <p className="text-xs text-muted">
            This closes any open positions at market, logs the full session
            (downloadable as CSV below), then wipes the book back to a fresh{" "}
            {usd(stats.startingBankroll)} bankroll and opens a new paused session.
            Download a copy first if you want it now.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <a
              href="/admin/auto-trader/export"
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-background"
            >
              Download CSV first
            </a>
            <form action={clearAction}>
              <button
                type="submit"
                className="rounded-lg bg-negative px-3 py-1.5 text-xs font-semibold text-background"
              >
                Yes, clear &amp; reset
              </button>
            </form>
            <a
              href="/admin/auto-trader"
              className="rounded-lg px-3 py-1.5 text-xs text-muted hover:text-foreground"
            >
              Cancel
            </a>
          </div>
        </div>
      )}

      {/* Performance (current session) */}
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
              No runs yet. The cron triggers /api/jobs/auto-trade every 30 min.
            </p>
          )}
        </div>
      </div>

      {/* Recent trades (current session) */}
      <div className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
        {recent.length === 0 && (
          <p className="px-4 py-6 text-center text-muted">
            No open or closed trades in this session yet.
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

      {/* Archived sessions */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Past sessions</h2>
          <span className="text-xs text-muted">{archived.length} logged</span>
        </div>
        <div className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
          {archived.length === 0 && (
            <p className="px-4 py-6 text-center text-muted">
              No cleared sessions yet — clearing a session logs its results here.
            </p>
          )}
          {archived.map((s) => (
            <ArchivedRow key={s.id} s={s} />
          ))}
        </div>
      </div>

      <p className="text-xs text-muted">
        Start/Stop is the live control (the cron only trades while a session is
        running). Stop pauses without clearing; Clear logs the session, resets the
        book, and starts a fresh paused session. Capture ratio is realized P&amp;L
        over expected edge on closed arbs. This is the reserved bot book, separate
        from your owner book.
      </p>
    </div>
  );
}

function ArchivedRow({ s }: { s: TradingSession }) {
  const st = (s.stats ?? null) as
    | (PaperStats & { openAtClear?: number; closedAtClear?: number })
    | null;
  const realized = st?.realizedPnlUsd ?? 0;
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium">
          {when(s.startedAt)} → {when(s.endedAt)}
        </span>
        <a
          href={`/admin/auto-trader/export?session=${s.id}`}
          className="shrink-0 text-xs text-accent hover:underline"
        >
          Download CSV
        </a>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
        <span>{s.tradeCount ?? 0} trades</span>
        <span>
          realized{" "}
          <span className={`font-mono ${pnlClass(realized)}`}>
            {signed(realized)}
          </span>
        </span>
        {st && (
          <>
            <span>equity {usd(st.equityUsd ?? 0)}</span>
            <span>capture {pct(st.captureRatio)}</span>
            <span>
              {st.winCount ?? 0}/{st.closedCount ?? 0} won
            </span>
          </>
        )}
      </div>
    </div>
  );
}
