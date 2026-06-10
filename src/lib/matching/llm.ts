import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_MATCH_MODEL } from "../config";
import type { Event, Market } from "../db/schema";
import { chunk } from "../http";

/**
 * LLM verification pass: candidate pairs that survive the heuristic gate are
 * sent (batched) to a small Claude model that reads both titles AND both
 * resolution rules — the thing similarity scores are worst at — and proposes
 * market-level outcome mappings for multi-outcome events.
 */

export type PairForLlm = {
  pairId: string; // "<kalshiEventId>|<polymarketEventId>"
  kalshiEvent: Event;
  kalshiMarkets: Market[];
  polymarketEvent: Event;
  polymarketMarkets: Market[];
};

const Verdict = z.object({
  pair_id: z.string(),
  same_event: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  rules_differ: z.boolean().optional().default(false),
  market_links: z
    .array(
      z.object({
        kalshi_market_id: z.string(),
        polymarket_market_id: z.string(),
        outcome_inverted: z.boolean().optional().default(false),
      }),
    )
    .optional()
    .default([]),
});
export type LlmVerdict = z.infer<typeof Verdict>;

const VerdictList = z.array(Verdict);

const BATCH_SIZE = 20;

export async function verifyPairsWithLlm(
  pairs: PairForLlm[],
): Promise<Map<string, LlmVerdict>> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — cannot run LLM matching");
  }
  const client = new Anthropic();
  const out = new Map<string, LlmVerdict>();

  for (const batch of chunk(pairs, BATCH_SIZE)) {
    const response = await client.messages.create({
      model: ANTHROPIC_MATCH_MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: renderBatch(batch) }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    for (const verdict of parseVerdicts(text)) {
      out.set(verdict.pair_id, verdict);
    }
  }
  return out;
}

const SYSTEM_PROMPT = `You compare prediction-market events from Kalshi and Polymarket and decide whether each pair refers to the SAME real-world event with COMPATIBLE resolution criteria.

Be strict: identical-sounding titles with different thresholds, deadlines, resolution sources, or scopes are NOT the same event. When resolution rules are compatible but differ in nuance (different sources that almost always agree), mark same_event true but rules_differ true.

For pairs that match, also map individual markets (outcomes) between platforms using the market ids given. Set outcome_inverted=true when YES on the Kalshi market corresponds to NO on the Polymarket market.

Respond with ONLY a JSON array, one object per pair:
[{"pair_id": "...", "same_event": true/false, "confidence": 0.0-1.0, "reason": "one sentence", "rules_differ": true/false, "market_links": [{"kalshi_market_id": "...", "polymarket_market_id": "...", "outcome_inverted": false}]}]`;

function renderBatch(batch: PairForLlm[]): string {
  return batch
    .map((p) => {
      const km = p.kalshiMarkets
        .slice(0, 25)
        .map(
          (m) =>
            `    - id=${m.id} outcome="${m.outcomeLabel ?? m.question}" rules="${truncate(m.resolutionRules, 300)}"`,
        )
        .join("\n");
      const pm = p.polymarketMarkets
        .slice(0, 25)
        .map(
          (m) =>
            `    - id=${m.id} outcome="${m.outcomeLabel ?? m.question}" rules="${truncate(m.resolutionRules, 300)}"`,
        )
        .join("\n");
      return `PAIR ${p.pairId}
  KALSHI: "${p.kalshiEvent.title}" (closes ${p.kalshiEvent.closeTime?.toISOString() ?? "unknown"})
  markets:
${km}
  POLYMARKET: "${p.polymarketEvent.title}" (closes ${p.polymarketEvent.closeTime?.toISOString() ?? "unknown"})
  markets:
${pm}`;
    })
    .join("\n\n");
}

function truncate(s: string | null, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function parseVerdicts(text: string): LlmVerdict[] {
  // Tolerate prose around the JSON array.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    return VerdictList.parse(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return [];
  }
}
