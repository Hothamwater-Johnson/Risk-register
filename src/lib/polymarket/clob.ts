import { z } from "zod";
import { CLOB_BASE_URL } from "../config";
import { chunk, fetchJson } from "../http";

/**
 * Polymarket CLOB API — public read endpoints, no keys.
 * Prices are decimal strings in [0,1]; sizes are share counts.
 */

const Level = z.looseObject({ price: z.string(), size: z.string() });

const Book = z.looseObject({
  asset_id: z.string().optional().default(""),
  bids: z.array(Level).default([]),
  asks: z.array(Level).default([]),
});
export type ClobBook = z.infer<typeof Book>;

const BooksResponse = z.array(Book);

/** Batch-fetch orderbooks for YES token ids. Returns a map keyed by token id. */
export async function getClobBooks(
  tokenIds: string[],
): Promise<Map<string, ClobBook>> {
  const out = new Map<string, ClobBook>();
  for (const batch of chunk(tokenIds, 50)) {
    const json = await fetchJson(`${CLOB_BASE_URL}/books`, {
      method: "POST",
      body: JSON.stringify(batch.map((token_id) => ({ token_id }))),
    });
    for (const book of BooksResponse.parse(json)) {
      if (book.asset_id) out.set(book.asset_id, book);
    }
  }
  return out;
}

export async function getClobBook(tokenId: string): Promise<ClobBook> {
  const json = await fetchJson(
    `${CLOB_BASE_URL}/book?token_id=${encodeURIComponent(tokenId)}`,
    { next: { revalidate: 30 } },
  );
  return Book.parse(json);
}

const HistoryResponse = z.looseObject({
  history: z
    .array(z.looseObject({ t: z.number(), p: z.number() }))
    .default([]),
});

/** Price history for a CLOB token. Returns [unix_seconds, probability]. */
export async function getClobPriceHistory(opts: {
  tokenId: string;
  startTs: number;
  endTs: number;
  fidelityMinutes?: number;
}): Promise<Array<{ ts: number; prob: number }>> {
  const params = new URLSearchParams({
    market: opts.tokenId,
    startTs: String(opts.startTs),
    endTs: String(opts.endTs),
    fidelity: String(opts.fidelityMinutes ?? 60),
  });
  const json = await fetchJson(`${CLOB_BASE_URL}/prices-history?${params}`, {
    next: { revalidate: 300 },
  });
  return HistoryResponse.parse(json).history.map((h) => ({
    ts: h.t,
    prob: h.p,
  }));
}

export type BookSummary = {
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  /** Dollars executable within the top 5 levels of each side. */
  bidDepthUsd: number;
  askDepthUsd: number;
};

export function summarizeBook(book: ClobBook): BookSummary {
  // CLOB books are not guaranteed sorted; sort defensively.
  const bids = book.bids
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => b.price - a.price);
  const asks = book.asks
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    bestBid,
    bestAsk,
    mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
    bidDepthUsd: bids
      .slice(0, 5)
      .reduce((sum, l) => sum + l.price * l.size, 0),
    askDepthUsd: asks
      .slice(0, 5)
      .reduce((sum, l) => sum + l.price * l.size, 0),
  };
}
