import { z } from "zod";
import { KALSHI_BASE_URL } from "../config";
import { fetchJson } from "../http";

/**
 * Kalshi Trade API v2 — public market-data endpoints (no auth required).
 * Schemas are intentionally loose: unknown fields pass through, and anything
 * we don't strictly need is optional, so upstream additions don't break sync.
 *
 * Wire format (verified live 2026-06-11): prices are fixed-point decimal
 * STRINGS in dollars, suffixed `_dollars` (a binary contract pays $1, so
 * dollars in [0,1] ARE probabilities); counts are decimal strings suffixed
 * `_fp`. The old integer-cent fields (yes_bid, volume_24h, …) are gone.
 * All numbers below are normalized to plain `number | null` at parse time.
 */

/** Fixed-point decimal string (or number) → finite number, else null. */
const fpNum = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

const KalshiMarket = z.looseObject({
  ticker: z.string(),
  event_ticker: z.string().optional(),
  title: z.string().optional().default(""),
  yes_sub_title: z.string().nullish(),
  no_sub_title: z.string().nullish(),
  status: z.string().optional().default("unknown"),
  /**
   * Settlement outcome, "yes" | "no" once status is "finalized" (verified
   * live 2026-06-11 via scripts/check-kalshi-settlement.ts; the intermediate
   * "determined" status also carries a result but can still be within its
   * settlement timer — the settle job only trusts "finalized").
   */
  result: z.string().nullish(),
  close_time: z.string().nullish(),
  /** Probabilities in [0,1] after normalization. */
  yes_bid_dollars: fpNum,
  yes_ask_dollars: fpNum,
  no_bid_dollars: fpNum,
  no_ask_dollars: fpNum,
  last_price_dollars: fpNum,
  /** Contract counts (fractional trading allowed). */
  volume_fp: fpNum,
  volume_24h_fp: fpNum,
  open_interest_fp: fpNum,
  liquidity_dollars: fpNum,
  rules_primary: z.string().nullish(),
});
export type KalshiMarket = z.infer<typeof KalshiMarket>;

const KalshiEvent = z.looseObject({
  event_ticker: z.string(),
  series_ticker: z.string().nullish(),
  title: z.string().optional().default(""),
  sub_title: z.string().nullish(),
  category: z.string().nullish(),
  markets: z.array(KalshiMarket).optional(),
});
export type KalshiEvent = z.infer<typeof KalshiEvent>;

const EventsResponse = z.looseObject({
  events: z.array(KalshiEvent).default([]),
  cursor: z.string().nullish(),
});

const MarketsResponse = z.looseObject({
  markets: z.array(KalshiMarket).default([]),
  cursor: z.string().nullish(),
});

/**
 * Orderbook sides are arrays of [price_dollars, contracts] resting BIDS,
 * both serialized as decimal strings; normalized to numbers (price = prob).
 */
const fpLevel = z
  .tuple([z.union([z.number(), z.string()]), z.union([z.number(), z.string()])])
  .transform(([p, q]): [number, number] => [Number(p), Number(q)]);

const OrderbookResponse = z.looseObject({
  orderbook_fp: z.looseObject({
    yes_dollars: z.array(fpLevel).nullish(),
    no_dollars: z.array(fpLevel).nullish(),
  }),
});

export type KalshiOrderbook = {
  /** Resting YES bids as [probability, contracts], unsorted. */
  yes: Array<[number, number]>;
  /** Resting NO bids as [probability, contracts], unsorted. */
  no: Array<[number, number]>;
};

export async function getKalshiEventsPage(opts: {
  cursor?: string;
  limit?: number;
  status?: string;
  withNestedMarkets?: boolean;
}): Promise<{ events: KalshiEvent[]; cursor: string | null }> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 200),
    status: opts.status ?? "open",
  });
  if (opts.withNestedMarkets) params.set("with_nested_markets", "true");
  if (opts.cursor) params.set("cursor", opts.cursor);
  const json = await fetchJson(`${KALSHI_BASE_URL}/events?${params}`);
  const parsed = EventsResponse.parse(json);
  return { events: parsed.events, cursor: parsed.cursor ?? null };
}

export async function getKalshiMarketsByTickers(
  tickers: string[],
): Promise<KalshiMarket[]> {
  if (tickers.length === 0) return [];
  const params = new URLSearchParams({
    tickers: tickers.join(","),
    limit: String(Math.max(tickers.length, 100)),
  });
  const json = await fetchJson(`${KALSHI_BASE_URL}/markets?${params}`);
  return MarketsResponse.parse(json).markets;
}

export async function getKalshiOrderbook(
  ticker: string,
): Promise<KalshiOrderbook> {
  const json = await fetchJson(
    `${KALSHI_BASE_URL}/markets/${encodeURIComponent(ticker)}/orderbook`,
    { next: { revalidate: 30 } },
  );
  const book = OrderbookResponse.parse(json).orderbook_fp;
  return {
    yes: (book.yes_dollars ?? []).filter(levelIsFinite),
    no: (book.no_dollars ?? []).filter(levelIsFinite),
  };
}

const levelIsFinite = (l: [number, number]) =>
  Number.isFinite(l[0]) && Number.isFinite(l[1]);

const Candlestick = z.looseObject({
  end_period_ts: z.number(),
  price: z
    .looseObject({ close_dollars: fpNum, mean_dollars: fpNum })
    .nullish(),
  yes_bid: z.looseObject({ close_dollars: fpNum }).nullish(),
  yes_ask: z.looseObject({ close_dollars: fpNum }).nullish(),
  volume_fp: fpNum,
});

const CandlesticksResponse = z.looseObject({
  candlesticks: z.array(Candlestick).default([]),
});

/** Returns [unix_seconds, probability] points for charting. */
export async function getKalshiCandlesticks(opts: {
  seriesTicker: string;
  marketTicker: string;
  startTs: number;
  endTs: number;
  periodIntervalMinutes: 1 | 60 | 1440;
}): Promise<Array<{ ts: number; prob: number }>> {
  const params = new URLSearchParams({
    start_ts: String(opts.startTs),
    end_ts: String(opts.endTs),
    period_interval: String(opts.periodIntervalMinutes),
  });
  const json = await fetchJson(
    `${KALSHI_BASE_URL}/series/${encodeURIComponent(opts.seriesTicker)}/markets/${encodeURIComponent(opts.marketTicker)}/candlesticks?${params}`,
    { next: { revalidate: 300 } },
  );
  const { candlesticks } = CandlesticksResponse.parse(json);
  return candlesticks.flatMap((c) => {
    const close =
      c.price?.close_dollars ??
      c.price?.mean_dollars ??
      c.yes_bid?.close_dollars ??
      c.yes_ask?.close_dollars;
    return close === null || close === undefined ? [] : [{ ts: c.end_period_ts, prob: close }];
  });
}
