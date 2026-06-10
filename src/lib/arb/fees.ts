/**
 * Fee models for both platforms. Coefficients here are CONFIG, not truth:
 * both platforms revised fees in 2026 (Kalshi fee schedule Feb 2026,
 * Polymarket introduced taker fees April 2026). Verify against:
 *   https://kalshi.com/docs/kalshi-fee-schedule.pdf
 *   https://help.polymarket.com/en/articles/13364478-trading-fees
 * before trusting after-fee numbers with real money. The UI always shows
 * before-fee and after-fee edges separately for this reason.
 */

export type FeeCategory = "default" | "crypto" | "geopolitics";

/** Kalshi taker fee: ceil_to_cent(coef × P × (1−P)) per contract, P in dollars. */
const KALSHI_TAKER_COEF: Record<FeeCategory, number> = {
  default: 0.07,
  crypto: 0.1, // higher multiplier for some series — verify per series
  geopolitics: 0.07,
};

/** Polymarket taker fee per share, p(1−p)-scaled. Zero for geopolitics. */
const POLYMARKET_TAKER_COEF: Record<FeeCategory, number> = {
  default: 0.07,
  crypto: 0.07,
  geopolitics: 0,
};

const ceilToCent = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;

export function kalshiTakerFeePerShare(
  price: number,
  category: FeeCategory = "default",
): number {
  return ceilToCent(KALSHI_TAKER_COEF[category] * price * (1 - price));
}

export function polymarketTakerFeePerShare(
  price: number,
  category: FeeCategory = "default",
): number {
  return POLYMARKET_TAKER_COEF[category] * price * (1 - price);
}

export function feeCategoryFor(category: string | null | undefined): FeeCategory {
  const c = (category ?? "").toLowerCase();
  if (/crypto|bitcoin|ethereum/.test(c)) return "crypto";
  if (/geopolit|world|war|international/.test(c)) return "geopolitics";
  return "default";
}
