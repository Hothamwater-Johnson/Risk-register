import type { KalshiOrderbook } from "../kalshi/client";

/**
 * Kalshi orderbooks list resting BIDS on both sides ([probability, contracts]).
 * A resting NO bid at p is an offer to sell YES at (1 − p), so:
 *   - YES ask depth = top NO bids valued at their YES-cost
 *   - YES bid depth = top YES bids at face value
 */
export function summarizeKalshiBook(book: KalshiOrderbook): {
  bidDepthUsd: number;
  askDepthUsd: number;
} {
  const yesBids = [...book.yes].sort((a, b) => b[0] - a[0]);
  const noBids = [...book.no].sort((a, b) => b[0] - a[0]);

  const bidDepthUsd = yesBids
    .slice(0, 5)
    .reduce((sum, [price, qty]) => sum + price * qty, 0);
  const askDepthUsd = noBids
    .slice(0, 5)
    .reduce((sum, [price, qty]) => sum + (1 - price) * qty, 0);

  return { bidDepthUsd, askDepthUsd };
}
