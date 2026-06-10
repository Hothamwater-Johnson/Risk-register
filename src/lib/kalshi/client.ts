import { z } from "zod";
import { KALSHI_BASE_URL } from "../config";
import { fetchJson } from "../http";

/**
 * Kalshi Trade API v2 — public market-data endpoints (no auth required).
 * Schemas are intentionally loose: unknown fields pass through, and anything
 * we don't strictly need is optional, so upstream additions don't break sync.
 * Prices arrive in CENTS (0-100); convert with centsToProb at the edge.
 */

const KalshiMarket = z.looseObject({
  ticker: z.string(),
  event_ticker: z.string().optional(),
  title: z.string().optional().default(""),
  subtitle: z.string().nullish(),
  yes_sub_title: z.string().nullish(),
  status: z.string().optional().default("unknown"),
  close_time: z.string().nullish(),
  yes_bid: z.number().nullish(),
  yes_ask: z.number().nullish(),
  no_bid: z.number().nullish(),
  no_ask: z.number().nullish(),
  last_price: z.number().nullish(),
  volume: z.number().nullish(),
  volume_24h: z.number().nullish(),
  open_interest: z.number().nullish(),
  liquidity: z.number().nullish(),
  rules_primary: z.string().nullish(),
  category: z.string().nullish(),
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

/** Orderbook sides are arrays of [price_cents, contracts] resting BIDS. */
const OrderbookResponse = z.looseObject({
  orderbook: z.looseObject({
    yes: z.array(z.tuple([z.number(), z.number()])).nullish(),
    no: z.array(z.tuple([z.number(), z.number()])).nullish(),
  }),
});
export type KalshiOrderbook = z.infer<typeof OrderbookResponse>["orderbook"];

export const centsToProb = (cents: number | null | undefined): number | null =>
  cents === null || cents === undefined ? null : cents / 100;

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
  return OrderbookResponse.parse(json).orderbook;
}

const Candlestick = z.looseObject({
  end_period_ts: z.number(),
  price: z
    .looseObject({ close: z.number().nullish(), mean: z.number().nullish() })
    .nullish(),
  yes_bid: z.looseObject({ close: z.number().nullish() }).nullish(),
  yes_ask: z.looseObject({ close: z.number().nullish() }).nullish(),
  volume: z.number().nullish(),
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
      c.price?.close ?? c.price?.mean ?? c.yes_bid?.close ?? c.yes_ask?.close;
    return close === null || close === undefined
      ? []
      : [{ ts: c.end_period_ts, prob: close / 100 }];
  });
}
