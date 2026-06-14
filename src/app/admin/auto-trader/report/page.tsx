import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getReportData, hasAutoTraderAccess } from "@/lib/autoTrader";
import { AutoTraderReport } from "@/components/AutoTraderReport";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auto-trader report", robots: "noindex" };

type Props = { searchParams: Promise<{ token?: string }> };

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signed = (n: number) => `${n >= 0 ? "+" : ""}${usd(n)}`;
const pnlClass = (n: number) =>
  n > 0 ? "text-positive" : n < 0 ? "text-negative" : "";
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);

export default async function AutoTraderReportPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!(await hasAutoTraderAccess(token))) redirect("/admin/auto-trader");

  const data = await getReportData();
  const lt = data.lifetime;

  const cards: { label: string; value: string; cls?: string }[] = [
    { label: "Lifetime realized", value: signed(lt.realizedPnlUsd), cls: pnlClass(lt.realizedPnlUsd) },
    { label: "Capture ratio", value: pct(lt.captureRatio) },
    { label: "Win rate", value: pct(lt.winRate) },
    { label: "Sessions cleared", value: String(lt.sessionsCleared) },
    { label: "Trades (all)", value: String(lt.trades) },
    { label: "Current equity", value: usd(lt.currentEquityUsd) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Auto-trader · report</h1>
        <Link href="/admin/auto-trader" className="text-sm text-muted hover:text-foreground">
          ← Dashboard
        </Link>
      </div>

      {data.migrationNeeded && (
        <p className="rounded-xl border border-negative/40 bg-negative/10 px-4 py-3 text-xs text-negative">
          The <code>trading_sessions</code> table isn&apos;t migrated yet, so only
          the live session is shown. Run <code>drizzle/0003_trading_sessions.sql</code>.
        </p>
      )}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border text-sm sm:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="bg-card px-4 py-3">
            <div className="text-xs text-muted">{c.label}</div>
            <div className={`mt-0.5 font-mono ${c.cls ?? ""}`}>{c.value}</div>
          </div>
        ))}
      </div>

      <AutoTraderReport data={data} />

      <div className="rounded-xl border border-border bg-card p-4 text-xs">
        <div className="mb-2 font-semibold">Close reasons (current session)</div>
        {data.closeReasons.length === 0 ? (
          <p className="text-muted">No closed trades in the current session yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.closeReasons.map((r) => (
              <span
                key={r.reason}
                className="rounded-full border border-border px-2 py-0.5 font-mono"
              >
                {r.reason}: {r.count}
              </span>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-muted">
        Cumulative across every cleared session plus the live one. Capture ratio is
        realized P&amp;L over expected edge on closed arbs — the bot&apos;s honesty
        metric; expected-vs-realized shows whether displayed edges survive. Per-trade
        detail for past sessions is in their CSV exports on the dashboard.
      </p>
    </div>
  );
}
