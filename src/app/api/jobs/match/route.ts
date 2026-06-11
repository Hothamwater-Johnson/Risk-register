import { and, desc, eq, inArray } from "drizzle-orm";
import { MATCH_AUTO_CONFIRM, MATCH_LLM_THRESHOLD } from "@/lib/config";
import { db } from "@/lib/db/client";
import {
  eventMatches,
  events,
  marketLinks,
  markets,
  PLATFORM,
  type Event,
  type Market,
} from "@/lib/db/schema";
import { runJob } from "@/lib/jobs";
import { generateCandidates, type CandidatePair } from "@/lib/matching/candidates";
import { verifyPairsWithLlm, type LlmVerdict, type PairForLlm } from "@/lib/matching/llm";
import { normalizeTitle } from "@/lib/matching/normalize";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Cost/runtime bound: at most this many pairs go to the LLM per run. */
const MAX_LLM_PAIRS_PER_RUN = 100;
/** How many open events per platform to consider, highest volume first. */
const MAX_EVENTS_PER_PLATFORM = 3000;

export async function GET(req: Request) {
  return runJob(req, "match", async () => {
    const openOf = (platformId: number) =>
      db()
        .select()
        .from(events)
        .where(and(eq(events.platformId, platformId), eq(events.status, "open")))
        .orderBy(desc(events.volume24h))
        .limit(MAX_EVENTS_PER_PLATFORM);

    const [kalshiEvents, polyEvents, existing] = await Promise.all([
      openOf(PLATFORM.kalshi),
      openOf(PLATFORM.polymarket),
      db()
        .select({
          kalshiEventId: eventMatches.kalshiEventId,
          polymarketEventId: eventMatches.polymarketEventId,
        })
        .from(eventMatches),
    ]);

    const seen = new Set(
      existing.map((m) => `${m.kalshiEventId}|${m.polymarketEventId}`),
    );

    const candidates = generateCandidates(kalshiEvents, polyEvents)
      .filter(
        (c) => !seen.has(`${c.kalshiEvent.id}|${c.polymarketEvent.id}`),
      )
      .filter((c) => c.breakdown.total >= MATCH_LLM_THRESHOLD)
      .slice(0, MAX_LLM_PAIRS_PER_RUN);

    if (candidates.length === 0) {
      return { candidates: 0, llmVerified: 0 };
    }

    const marketsByEvent = await loadMarkets(candidates);
    const pairs: PairForLlm[] = candidates.map((c) => ({
      pairId: `${c.kalshiEvent.id}|${c.polymarketEvent.id}`,
      kalshiEvent: c.kalshiEvent,
      kalshiMarkets: marketsByEvent.get(c.kalshiEvent.id) ?? [],
      polymarketEvent: c.polymarketEvent,
      polymarketMarkets: marketsByEvent.get(c.polymarketEvent.id) ?? [],
    }));

    let verdicts: Map<string, LlmVerdict>;
    try {
      verdicts = await verifyPairsWithLlm(pairs);
    } catch (err) {
      // LLM unavailable (no key, no credits, outage): degrade to heuristics.
      // Candidates go straight to the /admin/matches review queue with
      // naively proposed market links; nothing is auto-confirmed.
      const queued = await queueHeuristicOnly(candidates, marketsByEvent);
      return {
        candidates: candidates.length,
        llmVerified: 0,
        queued,
        llmError: err instanceof Error ? err.message : String(err),
      };
    }

    let confirmed = 0;
    let queued = 0;
    let rejected = 0;
    for (const c of candidates) {
      const pairId = `${c.kalshiEvent.id}|${c.polymarketEvent.id}`;
      const verdict = verdicts.get(pairId);
      if (!verdict) continue; // LLM failed for this pair; retry next run

      const status = !verdict.same_event
        ? "rejected"
        : verdict.confidence >= MATCH_AUTO_CONFIRM.llm &&
            c.breakdown.total >= MATCH_AUTO_CONFIRM.heuristic
          ? "llm_confirmed"
          : "candidate";

      const [match] = await db()
        .insert(eventMatches)
        .values({
          kalshiEventId: c.kalshiEvent.id,
          polymarketEventId: c.polymarketEvent.id,
          status,
          confidence: verdict.confidence,
          method: "llm",
          scoreBreakdown: {
            heuristic: c.breakdown,
            llm: { reason: verdict.reason, rulesDiffer: verdict.rules_differ },
          },
          pairSlug:
            status === "rejected" ? null : pairSlug(c.kalshiEvent),
        })
        .onConflictDoNothing()
        .returning({ id: eventMatches.id });

      if (status === "rejected") rejected++;
      else if (status === "llm_confirmed") confirmed++;
      else queued++;

      if (match && status !== "rejected" && verdict.market_links.length > 0) {
        const valid = validateLinks(verdict.market_links, marketsByEvent, c);
        if (valid.length > 0) {
          await db()
            .insert(marketLinks)
            .values(
              valid.map((l) => ({
                eventMatchId: match.id,
                kalshiMarketId: l.kalshi_market_id,
                polymarketMarketId: l.polymarket_market_id,
                outcomeInverted: l.outcome_inverted,
                status,
                confidence: verdict.confidence,
              })),
            )
            .onConflictDoNothing();
        }
      }
    }

    return {
      candidates: candidates.length,
      llmVerified: verdicts.size,
      confirmed,
      queued,
      rejected,
    };
  });
}

/**
 * LLM-less fallback: queue candidates for human review with naively proposed
 * links — the single-market case is unambiguous, multi-outcome events link
 * only where normalized outcome labels coincide uniquely. The reviewer can
 * invert/reject from /admin/matches; nothing is confirmed automatically.
 */
async function queueHeuristicOnly(
  candidates: CandidatePair[],
  marketsByEvent: Map<string, Market[]>,
): Promise<number> {
  let queued = 0;
  for (const c of candidates) {
    const [match] = await db()
      .insert(eventMatches)
      .values({
        kalshiEventId: c.kalshiEvent.id,
        polymarketEventId: c.polymarketEvent.id,
        status: "candidate",
        confidence: null,
        method: "heuristic",
        scoreBreakdown: { heuristic: c.breakdown },
        pairSlug: pairSlug(c.kalshiEvent),
      })
      .onConflictDoNothing()
      .returning({ id: eventMatches.id });
    if (!match) continue;
    queued++;

    const links = proposeLinksHeuristically(
      marketsByEvent.get(c.kalshiEvent.id) ?? [],
      marketsByEvent.get(c.polymarketEvent.id) ?? [],
    );
    if (links.length > 0) {
      await db()
        .insert(marketLinks)
        .values(
          links.map((l) => ({
            eventMatchId: match.id,
            kalshiMarketId: l.kalshiMarketId,
            polymarketMarketId: l.polymarketMarketId,
            outcomeInverted: false,
            status: "candidate",
            confidence: null,
          })),
        )
        .onConflictDoNothing();
    }
  }
  return queued;
}

function proposeLinksHeuristically(
  kalshiMarkets: Market[],
  polyMarkets: Market[],
): Array<{ kalshiMarketId: string; polymarketMarketId: string }> {
  if (kalshiMarkets.length === 1 && polyMarkets.length === 1) {
    return [
      {
        kalshiMarketId: kalshiMarkets[0].id,
        polymarketMarketId: polyMarkets[0].id,
      },
    ];
  }
  const labelKey = (m: Market) =>
    [...normalizeTitle(m.outcomeLabel ?? m.question).tokens].sort().join(" ");
  const byLabel = (ms: Market[]) => {
    const map = new Map<string, Market[]>();
    for (const m of ms) {
      const key = labelKey(m);
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), m]);
    }
    return map;
  };
  const kByLabel = byLabel(kalshiMarkets);
  const pByLabel = byLabel(polyMarkets);
  const out: Array<{ kalshiMarketId: string; polymarketMarketId: string }> = [];
  for (const [key, kms] of kByLabel) {
    const pms = pByLabel.get(key);
    if (kms.length === 1 && pms?.length === 1) {
      out.push({ kalshiMarketId: kms[0].id, polymarketMarketId: pms[0].id });
    }
  }
  return out;
}

async function loadMarkets(
  candidates: CandidatePair[],
): Promise<Map<string, Market[]>> {
  const eventIds = [
    ...new Set(
      candidates.flatMap((c) => [c.kalshiEvent.id, c.polymarketEvent.id]),
    ),
  ];
  const rows = await db()
    .select()
    .from(markets)
    .where(inArray(markets.eventId, eventIds));
  const out = new Map<string, Market[]>();
  for (const m of rows) {
    if (!m.eventId) continue;
    (out.get(m.eventId) ?? out.set(m.eventId, []).get(m.eventId)!).push(m);
  }
  return out;
}

/** Only keep LLM-proposed links whose market ids belong to the right events. */
function validateLinks(
  links: Array<{
    kalshi_market_id: string;
    polymarket_market_id: string;
    outcome_inverted: boolean;
  }>,
  marketsByEvent: Map<string, Market[]>,
  c: CandidatePair,
) {
  const kalshiIds = new Set(
    (marketsByEvent.get(c.kalshiEvent.id) ?? []).map((m) => m.id),
  );
  const polyIds = new Set(
    (marketsByEvent.get(c.polymarketEvent.id) ?? []).map((m) => m.id),
  );
  return links.filter(
    (l) => kalshiIds.has(l.kalshi_market_id) && polyIds.has(l.polymarket_market_id),
  );
}

function pairSlug(kalshiEvent: Event): string {
  const base = kalshiEvent.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base}-${kalshiEvent.id.slice(0, 6)}`;
}
