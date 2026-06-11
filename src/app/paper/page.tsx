import type { Metadata } from "next";
import Link from "next/link";
import { Explainer } from "@/components/ui";
import { cents } from "@/lib/explain/copy";
import {
  getPaperTradeViews,
  hasPaperAccess,
  paperStats,
  type PaperTradeView,
} from "@/lib/paper";
import {
  closePaperTrade,
  deletePaperTrade,
  paperLogin,
  paperLogout,
  settlePaperTrade,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Paper trading", robots: "noindex" };

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const signed = (n: number) => (n >= 0 ? `+${money(n)}` : money(n));

type Props = { searchParams: Promise<{ denied?: string }> };

export default async function PaperPage({ searchParams }: Props) {
  const { denied } = await searchParams;
  if (!(await hasPaperAccess())) {
    return (
      <div className="mx-auto max-w-sm space-y-4 py-16">
        <h1 className="text-xl font-bold tracking-tight">Paper trading</h1>
        <p className="text-sm text-muted">
          Test the dashboard&apos;s signals with virtual money. Enter the admin
          token to unlock (it&apos;s stored as a cookie so you only do this
          once per device).
        </p>
        {denied === "1" && (
          <p className="text-sm font-medium text-negative">
            That token didn&apos;t match — check for stray spaces and try
            again.
          </p>
        )}
        <form action={paperLogin} className="flex gap-2">
          <input
            type="password"
            name="token"
            placeholder="ADMIN_TOKEN"
            required
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
          />
          <button className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">
            Unlock
          </button>
        </form>
      </div>
    );
  }

  const views = await getPaperTradeViews();
  const stats = paperStats(views);
  const open = views.filter((v) => v.trade.status === "open");
  const closed = views.filter((v) => v.trade.status === "closed");

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold tracking-tight">Paper trading</h1>
        <form action={paperLogout}>
          <button className="text-xs text-muted hover:text-foreground">
            lock
          </button>
        </form>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Equity" value={money(stats.equityUsd)} />
        <StatCard label="Cash free" value={money(stats.cashUsd)} />
        <StatCard
          label="Open P&L"
          value={signed(stats.unrealizedPnlUsd)}
          tone={stats.unrealizedPnlUsd}
        />
        <StatCard
          label="Realized P&L"
          value={signed(stats.realizedPnlUsd)}
          tone={stats.realizedPnlUsd}
        />
      </section>

      {stats.closedCount > 0 && (
        <section className="rounded-xl border border-border bg-card p-4 text-sm">
          <h2 className="text-sm font-semibold">Is the dashboard honest?</h2>
          <p className="mt-2 leading-relaxed text-muted">
            {stats.winCount} of {stats.closedCount} closed trades made money.
            {stats.captureRatio !== null && (
              <>
                {" "}
                Closed arb trades promised {money(stats.expectedPnlUsd)} at
                entry and delivered{" "}
                <strong
                  className={
                    stats.captureRatio >= 0.8 ? "text-positive" : "text-negative"
                  }
                >
                  {Math.round(stats.captureRatio * 100)}%
                </strong>{" "}
                of it.
              </>
            )}
          </p>
          <Explainer summary="How to read the capture ratio">
            Each arb trade records the after-fee edge the dashboard displayed
            at the moment you clicked. If realized profit consistently lands
            well below 100% of that promise, the model is too optimistic —
            usually stale snapshots, fee coefficients that drifted, or thin
            books — and the fee/depth settings in <code>src/lib/arb</code>{" "}
            need tightening. Near 100% means the displayed edges are real.
          </Explainer>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Open positions ({open.length})
        </h2>
        {open.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
            No open paper trades. Open one from any{" "}
            <Link href="/" className="text-accent underline">
              event page
            </Link>{" "}
            — the trade widget appears below the price boxes once unlocked.
          </p>
        )}
        {open.map((v) => (
          <TradeCard key={v.trade.id} view={v} />
        ))}
      </section>

      {closed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            History ({closed.length})
          </h2>
          {closed.map((v) => (
            <TradeCard key={v.trade.id} view={v} />
          ))}
        </section>
      )}

      <p className="text-xs leading-relaxed text-muted">
        Simulator fills assume you take the top of the book at the latest
        snapshot (5–15 min old) with no size impact beyond the thin-book flag,
        and fees are the same estimates the dashboard shows. Real fills are
        worse, never better — treat paper results as an upper bound.
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: number;
}) {
  const color =
    tone === undefined
      ? ""
      : tone > 0
        ? "text-positive"
        : tone < 0
          ? "text-negative"
          : "";
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 font-mono text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

function legLabel(
  venue: "Kalshi" | "Polymarket",
  side: string | null,
  entry: number | null,
): string | null {
  if (!side || entry === null) return null;
  return `${side.toUpperCase()} ${venue} @ ${cents(entry)}`;
}

function TradeCard({ view }: { view: PaperTradeView }) {
  const { trade, kalshiMarket, event, mark } = view;
  const isOpen = trade.status === "open";
  const legs = [
    legLabel("Kalshi", trade.kalshiSide, trade.kalshiEntry),
    legLabel("Polymarket", trade.polySide, trade.polyEntry),
  ].filter(Boolean);
  const isArb = trade.expectedEdge !== null;
  const pnl = isOpen ? mark.unrealizedPnlUsd : trade.realizedPnlUsd;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {event?.title ?? kalshiMarket?.question ?? "Unknown market"}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {legs.join(" + ")} × {trade.shares.toLocaleString()}
            {isArb && ` · promised +${((trade.expectedEdge ?? 0) * 100).toFixed(1)}¢/share`}
            {trade.thinBookAtEntry && " · thin book at entry"}
          </p>
          {trade.thesis && (
            <p className="mt-1 text-xs italic text-muted">“{trade.thesis}”</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p
            className={`font-mono text-sm font-bold ${
              pnl === null ? "text-muted" : pnl >= 0 ? "text-positive" : "text-negative"
            }`}
          >
            {pnl === null ? "no quote" : signed(pnl)}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            cost {money(view.costUsd)}
            {!isOpen && trade.closeReason && ` · ${trade.closeReason.replace("_", " ")}`}
          </p>
        </div>
      </div>

      {isOpen && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <TradeAction action={closePaperTrade} tradeId={trade.id} label="Close at market" />
          <TradeAction
            action={settlePaperTrade}
            tradeId={trade.id}
            label="Settled YES"
            extra={{ outcome: "yes" }}
          />
          <TradeAction
            action={settlePaperTrade}
            tradeId={trade.id}
            label="Settled NO"
            extra={{ outcome: "no" }}
          />
          <TradeAction
            action={deletePaperTrade}
            tradeId={trade.id}
            label="Delete"
            subtle
          />
        </div>
      )}
    </div>
  );
}

function TradeAction({
  action,
  tradeId,
  label,
  extra,
  subtle,
}: {
  action: (formData: FormData) => Promise<void>;
  tradeId: string;
  label: string;
  extra?: Record<string, string>;
  subtle?: boolean;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="tradeId" value={tradeId} />
      {Object.entries(extra ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button
        className={
          subtle
            ? "rounded-lg px-3 py-1.5 text-xs text-muted hover:text-negative"
            : "rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-accent"
        }
      >
        {label}
      </button>
    </form>
  );
}
