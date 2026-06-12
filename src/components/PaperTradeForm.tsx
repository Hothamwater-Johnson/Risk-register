"use client";

import { useActionState, useState } from "react";
import {
  kalshiTakerFeePerShare,
  polymarketTakerFeePerShare,
  type FeeCategory,
} from "@/lib/arb/fees";
import { openPaperTrade, type OpenTradeMode, type OpenTradeState } from "@/app/paper/actions";
import { usd2 } from "@/lib/explain/copy";

export type TradeMode = {
  value: OpenTradeMode;
  label: string;
  /** Per-share entry prices for the legs this mode buys (null = no leg). */
  kalshiPrice: number | null;
  polyPrice: number | null;
  netEdge: number | null;
};

export type PaperTradeFormProps = {
  linkId: string;
  feeCategory: FeeCategory;
  /** Server-generated so SSR and hydration agree; rotated client-side after a fill. */
  initialKey: string;
  modes: TradeMode[];
  /** Arb-mode depth: how much is actually fillable at the displayed prices. */
  executableUsd: number | null;
  thinBook: boolean;
};

const SHARE_PRESETS = [25, 100, 250, 500];

const initialState: OpenTradeState = { status: "idle" };

export function PaperTradeForm(props: PaperTradeFormProps) {
  const [state, formAction, pending] = useActionState(openPaperTrade, initialState);
  const [key, setKey] = useState(props.initialKey);
  const [mode, setMode] = useState<OpenTradeMode>(props.modes[0]?.value ?? "arb");
  const [shares, setShares] = useState(100);

  // A used key must never be reused: rotate once the server confirms it
  // landed (or was a duplicate), so a deliberate second trade gets through.
  // State-during-render (guarded) instead of an effect, per react-hooks lint.
  if (
    (state.status === "opened" || state.status === "duplicate") &&
    state.usedKey === key
  ) {
    setKey(crypto.randomUUID());
  }

  const selected = props.modes.find((m) => m.value === mode) ?? props.modes[0];
  const breakdown = selected ? costBreakdown(selected, shares, props.feeCategory) : null;
  const showThinBook = mode === "arb" && props.thinBook && props.executableUsd !== null;

  return (
    <form action={formAction} className="mt-3 space-y-2">
      <input type="hidden" name="linkId" value={props.linkId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <select
        name="mode"
        value={mode}
        onChange={(e) => setMode(e.target.value as OpenTradeMode)}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      >
        {props.modes.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      <div className="flex flex-wrap items-center gap-1.5">
        {SHARE_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setShares(n)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
              shares === n
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-muted hover:border-accent"
            }`}
          >
            {n}
          </button>
        ))}
        <input
          type="number"
          name="shares"
          min={1}
          step={1}
          value={shares}
          onChange={(e) => setShares(Math.max(0, Number(e.target.value)))}
          required
          inputMode="numeric"
          aria-label="Shares"
          className="w-24 rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-sm"
        />
        <span className="text-xs text-muted">shares</span>
      </div>

      {breakdown && shares > 0 && (
        <div className="rounded-lg bg-background p-3 text-xs leading-relaxed text-muted">
          <div className="flex justify-between">
            <span>Entry {Math.round(breakdown.perShare * 100)}¢/share × {shares.toLocaleString()}</span>
            <span className="font-mono">{usd2(breakdown.entryUsd)}</span>
          </div>
          <div className="flex justify-between">
            <span>Estimated fees</span>
            <span className="font-mono">{usd2(breakdown.feesUsd)}</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-border pt-1 font-medium text-foreground">
            <span>Total cost</span>
            <span className="font-mono">{usd2(breakdown.totalUsd)}</span>
          </div>
          {selected?.netEdge !== null && selected?.netEdge !== undefined && (
            <div className="flex justify-between">
              <span>Edge promised if held to payout</span>
              <span className={`font-mono ${selected.netEdge > 0 ? "text-positive" : ""}`}>
                +{usd2(selected.netEdge * shares)}
              </span>
            </div>
          )}
        </div>
      )}

      {showThinBook && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          Thin book: only about {usd2(props.executableUsd ?? 0)} is actually
          fillable at these prices. A real order this size would move the
          market — treat the result as a signal, not proof.
        </p>
      )}

      <input
        type="text"
        name="thesis"
        placeholder="Why? (optional, future-you will ask)"
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />

      <button
        disabled={pending || shares <= 0}
        className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Opening…" : "Open position"}
      </button>

      {state.status === "opened" && (
        <p className="rounded-lg bg-positive/10 p-3 text-xs font-medium leading-relaxed text-positive">
          ✓ {state.message}
        </p>
      )}
      {state.status === "duplicate" && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          {state.message}
        </p>
      )}
      {state.status === "error" && (
        <p className="rounded-lg bg-negative/10 p-3 text-xs font-medium leading-relaxed text-negative">
          {state.message}
        </p>
      )}

      <p className="text-xs text-muted">
        Virtual money. Fills are re-priced server-side at the latest
        snapshot&apos;s ask when you tap — the fill can differ slightly from
        the numbers above, just like a real order. No orders are sent anywhere.
      </p>
    </form>
  );
}

function costBreakdown(mode: TradeMode, shares: number, feeCat: FeeCategory) {
  const perShare = (mode.kalshiPrice ?? 0) + (mode.polyPrice ?? 0);
  const feesUsd =
    (mode.kalshiPrice !== null
      ? kalshiTakerFeePerShare(mode.kalshiPrice, feeCat) * shares
      : 0) +
    (mode.polyPrice !== null
      ? polymarketTakerFeePerShare(mode.polyPrice, feeCat) * shares
      : 0);
  const entryUsd = perShare * shares;
  return { perShare, entryUsd, feesUsd, totalUsd: entryUsd + feesUsd };
}
