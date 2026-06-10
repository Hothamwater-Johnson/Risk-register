import Link from "next/link";
import { openPaperTrade } from "@/app/paper/actions";
import { cents } from "@/lib/explain/copy";
import type { LinkView } from "@/lib/queries";

/**
 * Server-rendered paper-trade form, shown on pair pages only when the paper
 * cookie is set (see /paper). Modes are in canonical Kalshi-question terms;
 * the action maps them onto the real Polymarket book when the link is
 * inverted. Prices are re-derived server-side at submit, so the fill may
 * differ slightly from the labels here — by design.
 */
export function PaperTradeWidget({ view }: { view: LinkView }) {
  const { spread, link } = view;
  const arb = spread.arb;
  const ks = view.kalshiSnapshot;
  const ps = view.polymarketSnapshot;
  // Canonical asks on the Polymarket side (flip when inverted).
  const pmYesAsk = link.outcomeInverted ? (ps?.noAsk ?? null) : (ps?.yesAsk ?? null);
  const pmNoAsk = link.outcomeInverted ? (ps?.yesAsk ?? null) : (ps?.noAsk ?? null);

  const modes: { value: string; label: string }[] = [];
  if (arb) {
    const yesVenue = arb.direction === "yes_kalshi" ? "Kalshi" : "Polymarket";
    const noVenue = arb.direction === "yes_kalshi" ? "Polymarket" : "Kalshi";
    modes.push({
      value: "arb",
      label: `Arb: YES ${yesVenue} ${cents(arb.yesAsk)} + NO ${noVenue} ${cents(arb.noAsk)} (${(arb.netEdge * 100).toFixed(1)}¢/share after fees)`,
    });
  }
  if (ks?.yesAsk != null)
    modes.push({ value: "yes_kalshi", label: `Buy YES on Kalshi @ ${cents(ks.yesAsk)}` });
  if (ks?.noAsk != null)
    modes.push({ value: "no_kalshi", label: `Buy NO on Kalshi @ ${cents(ks.noAsk)}` });
  if (pmYesAsk != null)
    modes.push({ value: "yes_polymarket", label: `Buy YES on Polymarket @ ${cents(pmYesAsk)}` });
  if (pmNoAsk != null)
    modes.push({ value: "no_polymarket", label: `Buy NO on Polymarket @ ${cents(pmNoAsk)}` });

  if (modes.length === 0) return null;

  return (
    <section className="rounded-xl border border-dashed border-accent/40 bg-card p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Paper trade this</h2>
        <Link href="/paper" className="text-xs text-accent hover:underline">
          portfolio →
        </Link>
      </div>
      <form action={openPaperTrade} className="mt-3 space-y-2">
        <input type="hidden" name="linkId" value={link.id} />
        <select
          name="mode"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          {modes.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <input
            type="number"
            name="shares"
            min={1}
            step={1}
            defaultValue={100}
            required
            aria-label="Shares"
            className="w-28 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
          />
          <input
            type="text"
            name="thesis"
            placeholder="Why? (optional, future-you will ask)"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          <button className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">
            Open
          </button>
        </div>
        <p className="text-xs text-muted">
          Virtual money. Fills at the latest snapshot&apos;s ask, fees
          estimated — no orders are sent anywhere.
        </p>
      </form>
    </section>
  );
}
