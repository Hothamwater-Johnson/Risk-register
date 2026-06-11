/**
 * Fee models for both platforms. Coefficients here are CONFIG, not truth.
 * Verified 2026-06-11 against:
 *   - Kalshi series API (`/series/{ticker}` → fee_type, fee_multiplier):
 *     uniform `quadratic` with fee_multiplier=1 across every category
 *     sampled (incl. Crypto); sports series also carry maker fees, which
 *     we don't model (we always price as taker).
 *   - https://help.polymarket.com/en/articles/13364478-trading-fees:
 *     taker fees ONLY on sports markets created after 2026-03-30
 *     (feeRate 0.03, sells exempt); Geopolitics & World Events are
 *     entirely fee-free; other categories have no fees yet but
 *     "future expansions" are announced — re-verify periodically.
 * The UI always shows before-fee and after-fee edges separately because
 * these schedules change.
 */

export type FeeCategory = "default" | "crypto" | "geopolitics" | "sports";

/** Kalshi taker fee: ceil_to_cent(coef × P × (1−P)) per contract, P in dollars. */
const KALSHI_TAKER_COEF: Record<FeeCategory, number> = {
  default: 0.07,
  crypto: 0.07,
  geopolitics: 0.07,
  sports: 0.07,
};

/** Polymarket taker fee per share on BUYS, p(1−p)-scaled. Sells are exempt. */
const POLYMARKET_TAKER_COEF: Record<FeeCategory, number> = {
  default: 0,
  crypto: 0,
  geopolitics: 0,
  sports: 0.03,
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
  opts: { isSell?: boolean } = {},
): number {
  if (opts.isSell) return 0;
  return POLYMARKET_TAKER_COEF[category] * price * (1 - price);
}

export function feeCategoryFor(category: string | null | undefined): FeeCategory {
  const c = (category ?? "").toLowerCase();
  if (/sport|nba|nfl|mlb|nhl|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma/.test(c))
    return "sports";
  if (/crypto|bitcoin|ethereum/.test(c)) return "crypto";
  if (/geopolit|world|war|international/.test(c)) return "geopolitics";
  return "default";
}
