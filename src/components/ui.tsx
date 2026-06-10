import Link from "next/link";
import type { ReactNode } from "react";
import { cents, pct } from "@/lib/explain/copy";
import type { LinkView, PairView } from "@/lib/queries";

export function PlatformChip({
  platform,
  prob,
}: {
  platform: "kalshi" | "polymarket";
  prob: number | null;
}) {
  const label = platform === "kalshi" ? "Kalshi" : "Polymarket";
  const color =
    platform === "kalshi"
      ? "bg-emerald-500/10 text-positive"
      : "bg-indigo-500/10 text-accent";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${color}`}
    >
      {label}
      <span className="font-mono font-semibold">
        {prob === null ? "—" : pct(prob)}
      </span>
    </span>
  );
}

/** Tappable plain-English explainer — pure HTML, no client JS. */
export function Explainer({
  summary = "What does this mean?",
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="group mt-2 rounded-lg bg-card text-sm">
      <summary className="cursor-pointer select-none list-none text-xs font-medium text-accent">
        {summary} <span className="group-open:hidden">▸</span>
        <span className="hidden group-open:inline">▾</span>
      </summary>
      <div className="mt-2 leading-relaxed text-muted">{children}</div>
    </details>
  );
}

export function GapBadge({ gap }: { gap: number }) {
  const tone =
    gap >= 0.05
      ? "bg-negative/10 text-negative"
      : gap >= 0.02
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-neutral-500/10 text-muted";
  return (
    <span className={`rounded-md px-2 py-0.5 font-mono text-xs font-bold ${tone}`}>
      {cents(gap)} gap
    </span>
  );
}

export function bestLink(pair: PairView): LinkView | null {
  return (
    [...pair.links].sort(
      (a, b) => (b.spread.disagreement ?? -1) - (a.spread.disagreement ?? -1),
    )[0] ?? null
  );
}

export function PairCard({ pair }: { pair: PairView }) {
  const top = bestLink(pair);
  if (!top) return null;
  const { spread } = top;
  const arb = spread.arb;
  return (
    <Link
      href={`/e/${pair.match.pairSlug}`}
      className="block rounded-xl border border-border bg-card p-4 transition-colors hover:border-accent"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold leading-snug">
          {pair.kalshiEvent.title}
        </h3>
        {spread.disagreement !== null && <GapBadge gap={spread.disagreement} />}
      </div>
      {top.kalshiMarket.outcomeLabel && pair.links.length > 1 && (
        <p className="mt-0.5 text-xs text-muted">
          Biggest gap: {top.kalshiMarket.outcomeLabel} ·{" "}
          {pair.links.length} outcomes tracked
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <PlatformChip platform="kalshi" prob={spread.kalshiMid} />
        <PlatformChip platform="polymarket" prob={spread.polymarketMid} />
        {arb && !arb.thinBook && arb.netEdge > 0 && (
          <span className="rounded-md bg-positive/10 px-2 py-0.5 text-xs font-semibold text-positive">
            +{(arb.netEdge * 100).toFixed(1)}¢ after fees
          </span>
        )}
        {arb?.thinBook && (
          <span className="rounded-md bg-neutral-500/10 px-2 py-0.5 text-xs text-muted">
            thin book
          </span>
        )}
        {pair.rulesDiffer && (
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
            rules differ
          </span>
        )}
      </div>
    </Link>
  );
}

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}
