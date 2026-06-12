"use client";

import { useState } from "react";
import { closePaperTrade } from "@/app/paper/actions";
import { usd2 } from "@/lib/explain/copy";

/**
 * Two-tap close: the first tap shows what closing at the latest snapshot
 * would net (bids minus exit fees), the second actually closes. The server
 * re-derives the fill at confirm time, so the final numbers can differ
 * slightly — same glance-to-click slippage as opening.
 */
export function ClosePreviewButton(props: {
  tradeId: string;
  valueUsd: number | null;
  pnlUsd: number | null;
  exitFeesUsd: number | null;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-accent"
      >
        Close at market
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2 rounded-lg bg-background px-2 py-1.5 text-xs">
      {props.valueUsd === null ? (
        <span className="text-muted">
          No current bid to preview — closing may fail until the next snapshot.
        </span>
      ) : (
        <span className="text-muted">
          Sells at the current bids for ≈{" "}
          <strong className="text-foreground">{usd2(props.valueUsd)}</strong>
          {props.exitFeesUsd !== null && ` after ${usd2(props.exitFeesUsd)} fees`}
          {props.pnlUsd !== null && (
            <>
              {" "}
              (<strong className={props.pnlUsd >= 0 ? "text-positive" : "text-negative"}>
                {props.pnlUsd >= 0 ? "+" : ""}
                {usd2(props.pnlUsd)}
              </strong>
              ) —
            </>
          )}{" "}
          re-priced at confirm.
        </span>
      )}
      <form action={closePaperTrade} className="contents">
        <input type="hidden" name="tradeId" value={props.tradeId} />
        <button className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-white">
          Confirm close
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
