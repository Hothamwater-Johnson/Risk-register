import { randomUUID } from "crypto";
import Link from "next/link";
import { feeCategoryFor } from "@/lib/arb/fees";
import { cents } from "@/lib/explain/copy";
import type { LinkView } from "@/lib/queries";
import { PaperTradeForm, type TradeMode } from "./PaperTradeForm";

/**
 * Paper-trade widget on pair pages, shown only to a signed-in identity (see
 * /paper). Modes are in canonical Kalshi-question terms; the action maps them
 * onto the real Polymarket book when the link is inverted. This server half
 * derives the mode list and prices from the latest snapshots and mints the
 * idempotency key; the client half (PaperTradeForm) owns pending state, the
 * cost breakdown, and submit feedback.
 */
export function PaperTradeWidget({
  view,
  category,
}: {
  view: LinkView;
  category: string | null | undefined;
}) {
  const { spread, link } = view;
  const arb = spread.arb;
  const ks = view.kalshiSnapshot;
  const ps = view.polymarketSnapshot;
  // Canonical asks on the Polymarket side (flip when inverted).
  const pmYesAsk = link.outcomeInverted ? (ps?.noAsk ?? null) : (ps?.yesAsk ?? null);
  const pmNoAsk = link.outcomeInverted ? (ps?.yesAsk ?? null) : (ps?.noAsk ?? null);

  const modes: TradeMode[] = [];
  if (arb) {
    const yesVenue = arb.direction === "yes_kalshi" ? "Kalshi" : "Polymarket";
    const noVenue = arb.direction === "yes_kalshi" ? "Polymarket" : "Kalshi";
    modes.push({
      value: "arb",
      label: `Arb: YES ${yesVenue} ${cents(arb.yesAsk)} + NO ${noVenue} ${cents(arb.noAsk)} (${(arb.netEdge * 100).toFixed(1)}¢/share after fees)`,
      kalshiPrice: arb.direction === "yes_kalshi" ? arb.yesAsk : arb.noAsk,
      polyPrice: arb.direction === "yes_kalshi" ? arb.noAsk : arb.yesAsk,
      netEdge: arb.netEdge,
    });
  }
  if (ks?.yesAsk != null)
    modes.push({
      value: "yes_kalshi",
      label: `Buy YES on Kalshi @ ${cents(ks.yesAsk)}`,
      kalshiPrice: ks.yesAsk,
      polyPrice: null,
      netEdge: null,
    });
  if (ks?.noAsk != null)
    modes.push({
      value: "no_kalshi",
      label: `Buy NO on Kalshi @ ${cents(ks.noAsk)}`,
      kalshiPrice: ks.noAsk,
      polyPrice: null,
      netEdge: null,
    });
  if (pmYesAsk != null)
    modes.push({
      value: "yes_polymarket",
      label: `Buy YES on Polymarket @ ${cents(pmYesAsk)}`,
      kalshiPrice: null,
      polyPrice: pmYesAsk,
      netEdge: null,
    });
  if (pmNoAsk != null)
    modes.push({
      value: "no_polymarket",
      label: `Buy NO on Polymarket @ ${cents(pmNoAsk)}`,
      kalshiPrice: null,
      polyPrice: pmNoAsk,
      netEdge: null,
    });

  if (modes.length === 0) return null;

  return (
    <section className="rounded-xl border border-dashed border-accent/40 bg-card p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Paper trade this</h2>
        <Link href="/paper" className="text-xs text-accent hover:underline">
          portfolio →
        </Link>
      </div>
      <PaperTradeForm
        linkId={link.id}
        feeCategory={feeCategoryFor(category)}
        initialKey={randomUUID()}
        modes={modes}
        executableUsd={arb?.executableUsd ?? null}
        thinBook={arb?.thinBook ?? false}
      />
    </section>
  );
}
