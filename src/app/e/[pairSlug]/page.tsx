import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PaperTradeWidget } from "@/components/PaperTradeWidget";
import { SpreadChart } from "@/components/SpreadChart";
import { bestLink, Explainer, GapBadge, PlatformChip } from "@/components/ui";
import {
  cents,
  explainArb,
  explainAutoMatched,
  explainDisagreement,
  explainPrice,
  explainRulesDiffer,
  explainThinBook,
  pct,
} from "@/lib/explain/copy";
import { hasPaperAccess } from "@/lib/paper";
import {
  getPairBySlug,
  getSpreadHistory,
  platformUrl,
  type LinkView,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pairSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { pairSlug } = await params;
  const pair = await getPairBySlug(pairSlug).catch(() => null);
  return { title: pair?.kalshiEvent.title ?? "Event" };
}

export default async function PairPage({ params }: Props) {
  const { pairSlug } = await params;
  const pair = await getPairBySlug(pairSlug).catch(() => null);
  if (!pair) notFound();

  const top = bestLink(pair);
  const [history, paperUnlocked] = await Promise.all([
    top ? getSpreadHistory(top.link, 7) : Promise.resolve([]),
    hasPaperAccess(),
  ]);

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-lg font-bold leading-snug">{pair.kalshiEvent.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {top?.spread.disagreement != null && (
            <GapBadge gap={top.spread.disagreement} />
          )}
          {pair.match.status === "llm_confirmed" && (
            <span className="rounded-md bg-neutral-500/10 px-2 py-0.5 text-xs text-muted">
              auto-matched
            </span>
          )}
        </div>
        {pair.match.status === "llm_confirmed" && (
          <p className="mt-1 text-xs text-muted">{explainAutoMatched()}</p>
        )}
      </section>

      {top && <LinkDetail view={top} multi={pair.links.length > 1} />}

      {top && paperUnlocked && <PaperTradeWidget view={top} />}

      {top && (
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">Both platforms, last 7 days</h2>
          <SpreadChart points={history} />
        </section>
      )}

      {pair.links.length > 1 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            All linked outcomes
          </h2>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {pair.links.map((l) => (
              <div key={l.link.id} className="px-4 py-3">
                <p className="text-sm font-medium">
                  {l.kalshiMarket.outcomeLabel ?? l.kalshiMarket.question}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <PlatformChip platform="kalshi" prob={l.spread.kalshiMid} />
                  <PlatformChip platform="polymarket" prob={l.spread.polymarketMid} />
                  {l.spread.disagreement != null && (
                    <span className="font-mono text-xs text-muted">
                      Δ {cents(l.spread.disagreement)}
                    </span>
                  )}
                  {l.link.outcomeInverted && (
                    <span className="text-xs text-muted">(inverted)</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <RulesSection pair={pair} top={top} />

      <section className="flex flex-wrap gap-3 text-sm">
        {top && (
          <>
            <a
              href={platformUrl(top.kalshiMarket, pair.kalshiEvent)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-border px-4 py-2 font-medium hover:border-accent"
            >
              View on Kalshi ↗
            </a>
            <a
              href={platformUrl(top.polymarketMarket, pair.polymarketEvent)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-border px-4 py-2 font-medium hover:border-accent"
            >
              View on Polymarket ↗
            </a>
          </>
        )}
      </section>
    </div>
  );
}

function LinkDetail({ view, multi }: { view: LinkView; multi: boolean }) {
  const { spread, kalshiMarket } = view;
  const arb = spread.arb;
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      {multi && (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
          Biggest gap: {kalshiMarket.outcomeLabel ?? kalshiMarket.question}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <QuoteBox
          label="Kalshi"
          mid={spread.kalshiMid}
          bid={view.kalshiSnapshot?.yesBid ?? null}
          ask={view.kalshiSnapshot?.yesAsk ?? null}
        />
        <QuoteBox
          label="Polymarket"
          mid={spread.polymarketMid}
          bid={
            view.link.outcomeInverted
              ? (view.polymarketSnapshot?.noBid ?? null)
              : (view.polymarketSnapshot?.yesBid ?? null)
          }
          ask={
            view.link.outcomeInverted
              ? (view.polymarketSnapshot?.noAsk ?? null)
              : (view.polymarketSnapshot?.yesAsk ?? null)
          }
        />
      </div>

      {spread.kalshiMid != null && spread.polymarketMid != null && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-sm leading-relaxed">
            {explainDisagreement(spread.kalshiMid, spread.polymarketMid)}
          </p>
          {spread.kalshiMid != null && (
            <Explainer summary="How do prices become probabilities?">
              {explainPrice(spread.kalshiMid)}
            </Explainer>
          )}
        </div>
      )}

      {arb && arb.grossEdge > 0 && (
        <div className="mt-4 rounded-lg bg-background p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold">
              {arb.thinBook ? "Gap (likely not fillable)" : "Locked-in gap"}
            </span>
            <span className="font-mono text-xs">
              {(arb.grossEdge * 100).toFixed(1)}¢ before fees ·{" "}
              <strong
                className={arb.netEdge > 0 ? "text-positive" : "text-muted"}
              >
                {(arb.netEdge * 100).toFixed(1)}¢ after
              </strong>
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {explainArb(arb)}
          </p>
          {arb.thinBook && arb.executableUsd !== null && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {explainThinBook(arb.executableUsd)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function QuoteBox({
  label,
  mid,
  bid,
  ask,
}: {
  label: string;
  mid: number | null;
  bid: number | null;
  ask: number | null;
}) {
  return (
    <div className="rounded-lg bg-background p-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold">
        {mid === null ? "—" : pct(mid)}
      </p>
      <p className="mt-0.5 font-mono text-xs text-muted">
        {bid === null ? "—" : cents(bid)} bid / {ask === null ? "—" : cents(ask)} ask
      </p>
    </div>
  );
}

function RulesSection({
  pair,
  top,
}: {
  pair: NonNullable<Awaited<ReturnType<typeof getPairBySlug>>>;
  top: LinkView | null;
}) {
  const kRules = top?.kalshiMarket.resolutionRules;
  const pRules = top?.polymarketMarket.resolutionRules;
  if (!kRules && !pRules) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        Resolution rules
      </h2>
      {pair.rulesDiffer && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          {explainRulesDiffer()}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {kRules && <RuleBox label="Kalshi" text={kRules} />}
        {pRules && <RuleBox label="Polymarket" text={pRules} />}
      </div>
    </section>
  );
}

function RuleBox({ label, text }: { label: string; text: string }) {
  const excerpt = text.length > 600 ? text.slice(0, 600) + "…" : text;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs font-semibold">{label}</p>
      <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-muted">
        {excerpt}
      </p>
    </div>
  );
}
