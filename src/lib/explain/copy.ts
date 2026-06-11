import type { ArbResult } from "../arb/spread";

/**
 * Every plain-English explainer string in the product lives here, so tone
 * stays consistent and the weekly digest can reuse the exact same copy.
 * Numbers are always inlined into sentences — never explain in the abstract
 * when we can explain with the user's actual numbers.
 */

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const cents = (p: number) => `${Math.round(p * 100)}¢`;
export const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function explainPrice(prob: number): string {
  return `A price of ${cents(prob)} means traders collectively think there's about a ${pct(prob)} chance this happens. If you're right, each ${cents(prob)} share pays out $1.`;
}

export function explainDisagreement(
  kalshiMid: number,
  polymarketMid: number,
): string {
  const gap = Math.abs(kalshiMid - polymarketMid);
  const [hi, lo] =
    kalshiMid >= polymarketMid
      ? (["Kalshi", "Polymarket"] as const)
      : (["Polymarket", "Kalshi"] as const);
  return `${hi} traders think this is ${pct(Math.max(kalshiMid, polymarketMid))} likely; ${lo} traders say ${pct(Math.min(kalshiMid, polymarketMid))}. That ${cents(gap)} gap usually means one crowd knows something the other doesn't — or the markets aren't asking quite the same question. Check the resolution rules below before assuming it's free money.`;
}

export function explainArb(arb: ArbResult): string {
  const yesVenue = arb.direction === "yes_kalshi" ? "Kalshi" : "Polymarket";
  const noVenue = arb.direction === "yes_kalshi" ? "Polymarket" : "Kalshi";
  const cost = arb.yesAsk + arb.noAsk;
  const base = `If you bought YES on ${yesVenue} at ${cents(arb.yesAsk)} and NO on ${noVenue} at ${cents(arb.noAsk)}, you'd pay ${cents(cost)} total for a position that pays $1 no matter what happens — about ${(arb.netEdge * 100).toFixed(1)}¢ profit per share after estimated fees.`;
  const caveats = ` Caveats: prices move fast, you need funded accounts on both platforms, and fees shown are estimates.`;
  if (arb.thinBook) {
    return `${base} But the order books are thin — only about ${usd(arb.executableUsd ?? 0)} is actually fillable at these prices, so treat this as a signal, not a trade.${caveats}`;
  }
  return base + caveats;
}

export function explainThinBook(executableUsd: number): string {
  return `Only about ${usd(executableUsd)} can actually be traded at the displayed price before it moves. Gaps on thin books look like free money but usually evaporate when you try to fill them.`;
}

export function explainMover(title: string, change: number): string {
  const dir = change > 0 ? "jumped" : "dropped";
  return `"${title}" ${dir} ${Math.abs(Math.round(change * 100))} points in the last 24 hours — a move that size usually means real news, not noise.`;
}

export function explainRulesDiffer(): string {
  return `These two markets look like the same question, but the platforms may resolve them differently (different sources, deadlines, or thresholds). Read both rule sets before treating the gap as mispricing — "same event, different rules" is the most common way beginners lose money on cross-platform trades.`;
}

export function explainAutoMatched(): string {
  return `Our system matched these two markets automatically based on their titles and resolution rules. We're confident, but not certain — always glance at both rule sets.`;
}

/** Static glossary pages for /learn — also the SEO surface. */
export const LEARN_PAGES: Record<
  string,
  { title: string; description: string; body: string[] }
> = {
  "implied-probability": {
    title: "What is implied probability?",
    description:
      "Why a 62¢ prediction market price means a 62% chance — and when it doesn't.",
    body: [
      `Prediction market prices ARE probabilities. When a share of "Will X happen?" trades at 62¢, the market is saying there's roughly a 62% chance X happens. If it happens, every share pays $1; if not, $0.`,
      `That's the whole magic of these markets: instead of pundits saying "likely" or "doubtful", you get a number, updated in real time, backed by people risking money.`,
      `The caveats: prices on lightly-traded markets can be stale or pushed around by one big order, and prices very close to 0¢ or 100¢ are distorted because tying up money for a tiny payoff isn't worth it to traders. Treat mid-range prices on high-volume markets as the most trustworthy probabilities.`,
    ],
  },
  spread: {
    title: "What is the bid-ask spread?",
    description:
      "The gap between what buyers offer and sellers ask — and why it's your real trading cost.",
    body: [
      `At any moment a market has two prices: the bid (the most anyone will pay right now) and the ask (the least anyone will sell for). The gap between them is the spread.`,
      `If a market is 58¢ bid / 62¢ ask, the "price" you see quoted is usually the midpoint (60¢) — but you can't trade at it. Buying costs you 62¢; selling gets you 58¢. The spread is an invisible fee you pay the moment you trade.`,
      `Tight spreads (1–2¢) mean an active, healthy market. Wide spreads (5¢+) mean few traders — your real cost is higher and the displayed probability is fuzzier.`,
    ],
  },
  arbitrage: {
    title: "What is an arbitrage gap?",
    description:
      "When the same event is priced differently on two platforms, and what it takes to actually profit.",
    body: [
      `Sometimes Kalshi says an event is 62% likely while Polymarket says 57%. In theory you can buy YES on the cheap platform and NO on the expensive one, pay less than $1 combined, and collect exactly $1 when the market resolves — guaranteed profit either way.`,
      `In practice three things eat the gap: fees on both platforms, thin order books (the displayed price may only be good for a few dollars), and — most dangerous — subtly different resolution rules, where "the same event" isn't actually the same bet.`,
      `That's why we show gaps before and after estimated fees, flag thin books, and surface both platforms' rules side by side. A gap that survives all three checks is rare and usually small — but it's real.`,
    ],
  },
  fees: {
    title: "How do prediction market fees work?",
    description:
      "Kalshi and Polymarket both charge trading fees that scale with how uncertain the market is.",
    body: [
      `Both platforms charge "taker" fees when your order fills immediately against the order book, and both use formulas that scale with P × (1 − P) — meaning fees are highest on 50/50 markets and shrink toward zero as prices approach 0¢ or 100¢.`,
      `Kalshi's standard taker fee is about 7% of P × (1 − P) per contract, rounded up to the cent, uniform across categories. Polymarket introduced taker fees in 2026 but currently charges them only on sports markets (and only on buys — sells are free); geopolitics and everything else trade fee-free for now. Both platforms pay no fee — or even rebates — for resting "maker" orders.`,
      `For cross-platform gap trading this matters a lot: a 3¢ gap on a 50/50 market can lose half its edge to fees. We always show edges before and after estimated fees, and our fee estimates are just that — estimates. Check each platform's current fee schedule before trading real size.`,
    ],
  },
  "paper-trading": {
    title: "What is paper trading?",
    description:
      "Practicing with virtual money — and why your paper results are the ceiling, not the floor, of real performance.",
    body: [
      `Paper trading means recording the trades you would have made, at the prices you would have paid, without risking money. It's the standard way to test whether a strategy — or a signal like a cross-platform gap — actually works before funding an account.`,
      `The honest way to paper trade: fill at the ask (not the mid), subtract fees, value open positions at the bid (what you could really sell for), and write down what you expected to make when you entered. Then compare. If realized profits keep coming in below expectations, the signal is weaker than it looks — better to learn that with play money.`,
      `One warning: paper fills are always too generous. A simulator fills you instantly at the displayed price; a real order faces slippage, partial fills, and prices that move the moment you need them most. Treat paper results as an upper bound, and only take strategies live that look good with margin to spare.`,
    ],
  },
  "why-prices-differ": {
    title: "Why do Kalshi and Polymarket prices differ?",
    description:
      "Different traders, different rules, different friction — the anatomy of a cross-platform gap.",
    body: [
      `If markets were perfectly efficient, the same event would cost the same everywhere. Gaps persist for a few real reasons.`,
      `Different crowds: Kalshi is a US-regulated exchange (dollars, KYC); Polymarket runs on crypto rails with a global user base. The two pools of traders have different information, biases, and risk tolerance.`,
      `Different rules: two markets on "the same" event often resolve on different sources or deadlines. A gap can be the market correctly pricing two different questions.`,
      `Friction: moving money between platforms is slow and annoying, so small gaps aren't worth closing professionally. That friction is exactly why gaps are informative — when one platform moves first on news, the other usually follows.`,
    ],
  },
};
