import { MIN_EXECUTABLE_USD } from "../config";
import {
  feeCategoryFor,
  kalshiTakerFeePerShare,
  polymarketTakerFeePerShare,
} from "./fees";

export type Quote = {
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  mid: number | null;
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
};

export type SpreadResult = {
  /** |mid − mid| in probability points — always computable, always honest. */
  disagreement: number | null;
  kalshiMid: number | null;
  polymarketMid: number | null;
  arb: ArbResult | null;
};

export type ArbResult = {
  /** "yes_kalshi" = buy YES on Kalshi + NO on Polymarket; vice versa. */
  direction: "yes_kalshi" | "yes_polymarket";
  yesAsk: number;
  noAsk: number;
  /** Profit per $1 payout before fees: 1 − (yesAsk + noAsk). */
  grossEdge: number;
  feesPerShare: number;
  netEdge: number;
  /** min(executable $ on both legs); null when depth unknown. */
  executableUsd: number | null;
  thinBook: boolean;
};

/** Flip a quote when YES on one platform corresponds to NO on the other. */
export function invertQuote(q: Quote): Quote {
  return {
    yesBid: q.noBid,
    yesAsk: q.noAsk,
    noBid: q.yesBid,
    noAsk: q.yesAsk,
    mid: q.mid === null ? null : 1 - q.mid,
    bidDepthUsd: q.askDepthUsd,
    askDepthUsd: q.bidDepthUsd,
  };
}

/**
 * Compute the displayed numbers for one linked market pair.
 * Never uses last-trade prices: disagreement comes from mids, the arb from
 * asks (what you would actually pay), gated by executable depth.
 */
export function computeSpread(
  kalshi: Quote,
  polymarket: Quote,
  category: string | null | undefined,
  opts: { outcomeInverted?: boolean } = {},
): SpreadResult {
  const pm = opts.outcomeInverted ? invertQuote(polymarket) : polymarket;
  const feeCat = feeCategoryFor(category);

  const disagreement =
    kalshi.mid !== null && pm.mid !== null
      ? Math.abs(kalshi.mid - pm.mid)
      : null;

  const candidates: ArbResult[] = [];

  // Direction A: buy YES on Kalshi at its ask, buy NO on Polymarket at its ask.
  if (kalshi.yesAsk !== null && pm.noAsk !== null) {
    candidates.push(
      buildArb("yes_kalshi", kalshi.yesAsk, pm.noAsk, feeCat, kalshi, pm),
    );
  }
  // Direction B: buy YES on Polymarket, buy NO on Kalshi.
  if (pm.yesAsk !== null && kalshi.noAsk !== null) {
    candidates.push(
      buildArb("yes_polymarket", pm.yesAsk, kalshi.noAsk, feeCat, pm, kalshi),
    );
  }

  const best = candidates
    .filter((c) => c.grossEdge > 0)
    .sort((a, b) => b.netEdge - a.netEdge)[0];

  return {
    disagreement,
    kalshiMid: kalshi.mid,
    polymarketMid: pm.mid,
    arb: best ?? null,
  };
}

function buildArb(
  direction: ArbResult["direction"],
  yesAsk: number,
  noAsk: number,
  feeCat: ReturnType<typeof feeCategoryFor>,
  yesVenue: Quote,
  noVenue: Quote,
): ArbResult {
  const grossEdge = 1 - (yesAsk + noAsk);
  const kalshiLegPrice = direction === "yes_kalshi" ? yesAsk : noAsk;
  const polyLegPrice = direction === "yes_kalshi" ? noAsk : yesAsk;
  const feesPerShare =
    kalshiTakerFeePerShare(kalshiLegPrice, feeCat) +
    polymarketTakerFeePerShare(polyLegPrice, feeCat);

  const depths = [yesVenue.askDepthUsd, noVenue.askDepthUsd];
  const executableUsd = depths.some((d) => d === null)
    ? null
    : Math.min(...(depths as number[]));

  return {
    direction,
    yesAsk,
    noAsk,
    grossEdge,
    feesPerShare,
    netEdge: grossEdge - feesPerShare,
    executableUsd,
    thinBook: executableUsd !== null && executableUsd < MIN_EXECUTABLE_USD,
  };
}
