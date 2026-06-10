import { z } from "zod";
import { GAMMA_BASE_URL } from "../config";
import { fetchJson } from "../http";

/**
 * Polymarket Gamma API — public market/event metadata, no keys.
 * Gamma serializes several array fields as JSON strings ("[\"Yes\",\"No\"]")
 * and numbers sometimes arrive as strings; schemas normalize both.
 */

const numish = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

/** A JSON-string-encoded array of strings, or a plain array. */
const jsonStringArray = z
  .union([z.string(), z.array(z.string())])
  .nullish()
  .transform((v): string[] => {
    if (v === null || v === undefined) return [];
    if (Array.isArray(v)) return v;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  });

const GammaMarket = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  question: z.string().optional().default(""),
  conditionId: z.string().nullish(),
  slug: z.string().nullish(),
  groupItemTitle: z.string().nullish(),
  description: z.string().nullish(),
  outcomes: jsonStringArray,
  outcomePrices: jsonStringArray,
  clobTokenIds: jsonStringArray,
  bestBid: numish,
  bestAsk: numish,
  lastTradePrice: numish,
  volume24hr: numish,
  volumeNum: numish,
  liquidityNum: numish,
  endDate: z.string().nullish(),
  active: z.boolean().nullish(),
  closed: z.boolean().nullish(),
});
export type GammaMarket = z.infer<typeof GammaMarket>;

const GammaEvent = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  slug: z.string().nullish(),
  title: z.string().optional().default(""),
  description: z.string().nullish(),
  category: z.string().nullish(),
  endDate: z.string().nullish(),
  volume24hr: numish,
  liquidity: numish,
  closed: z.boolean().nullish(),
  markets: z.array(GammaMarket).default([]),
});
export type GammaEvent = z.infer<typeof GammaEvent>;

const GammaEventsResponse = z.array(GammaEvent);

export async function getGammaEventsPage(opts: {
  limit?: number;
  offset?: number;
}): Promise<GammaEvent[]> {
  const params = new URLSearchParams({
    limit: String(opts.limit ?? 100),
    offset: String(opts.offset ?? 0),
    active: "true",
    closed: "false",
    order: "volume24hr",
    ascending: "false",
  });
  const json = await fetchJson(`${GAMMA_BASE_URL}/events?${params}`);
  return GammaEventsResponse.parse(json);
}

/**
 * Map a Gamma market's outcomes to YES/NO clob token ids. Binary markets list
 * outcomes ["Yes","No"]; for grouped multi-outcome events each sub-market is
 * itself binary on its outcome.
 */
export function yesNoTokenIds(m: GammaMarket): {
  yes: string | null;
  no: string | null;
} {
  if (m.clobTokenIds.length < 2) {
    return { yes: m.clobTokenIds[0] ?? null, no: null };
  }
  const yesIdx = m.outcomes.findIndex((o) => o.toLowerCase() === "yes");
  if (yesIdx === -1) return { yes: m.clobTokenIds[0], no: m.clobTokenIds[1] };
  return {
    yes: m.clobTokenIds[yesIdx],
    no: m.clobTokenIds[yesIdx === 0 ? 1 : 0],
  };
}
