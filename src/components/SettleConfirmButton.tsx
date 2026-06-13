"use client";

import { useState } from "react";
import { settlePaperTrade } from "@/app/paper/actions";
import { usd2 } from "@/lib/explain/copy";

/**
 * Two-tap manual settlement: the first tap explains what "settled" means and
 * previews the payout, the second actually settles. Settlement is the
 * irreversible admin override for markets the platform really resolved —
 * a single stray thumb on a phone must never trigger it.
 */
export function SettleConfirmButton(props: {
  tradeId: string;
  outcome: "yes" | "no";
  /** Payout/P&L preview; null when the market link is missing. */
  payoutUsd: number | null;
  pnlUsd: number | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const label = `Settled ${props.outcome.toUpperCase()}`;

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-accent"
      >
        {label}
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2 rounded-lg bg-background px-2 py-1.5 text-xs">
      <span className="text-muted">
        Marks the Kalshi question as officially settled{" "}
        {props.outcome.toUpperCase()}
        {props.payoutUsd !== null && (
          <>
            {" "}
            and pays this trade out at{" "}
            <strong className="text-foreground">{usd2(props.payoutUsd)}</strong>
            {props.pnlUsd !== null && (
              <>
                {" "}
                (<strong
                  className={props.pnlUsd >= 0 ? "text-positive" : "text-negative"}
                >
                  {props.pnlUsd >= 0 ? "+" : ""}
                  {usd2(props.pnlUsd)}
                </strong>
                )
              </>
            )}
          </>
        )}{" "}
        — use only when the market really resolved; to exit at current prices
        use Close at market instead.
      </span>
      <form action={settlePaperTrade} className="contents">
        <input type="hidden" name="tradeId" value={props.tradeId} />
        <input type="hidden" name="outcome" value={props.outcome} />
        <button className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-white">
          Confirm {label.toLowerCase()}
        </button>
      </form>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-muted hover:text-foreground"
      >
        cancel
      </button>
    </span>
  );
}
