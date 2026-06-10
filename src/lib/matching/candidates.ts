import type { Event } from "../db/schema";
import { normalizeTitle, sharedNames, tokenSimilarity } from "./normalize";
import { ScoreBreakdown, scorePair } from "./score";

export type CandidatePair = {
  kalshiEvent: Event;
  polymarketEvent: Event;
  breakdown: ScoreBreakdown;
};

const DAY_MS = 86_400_000;
const CLOSE_WINDOW_DAYS = 5;
const MIN_BLOCK_SIMILARITY = 0.3;
const MIN_SHARED_ENTITIES = 2;

/**
 * Blocking + scoring, in memory. The open catalogs are a few thousand events
 * per platform; with the close-time window and cheap similarity gate the
 * pairwise pass is fine in JS and keeps us off DB extensions in V1.
 */
export function generateCandidates(
  kalshiEvents: Event[],
  polymarketEvents: Event[],
): CandidatePair[] {
  const polyNorm = polymarketEvents.map((e) => ({
    event: e,
    title: normalizeTitle(e.title),
  }));

  const out: CandidatePair[] = [];
  for (const ke of kalshiEvents) {
    const kTitle = normalizeTitle(ke.title);
    for (const pe of polyNorm) {
      if (!withinCloseWindow(ke.closeTime, pe.event.closeTime)) continue;

      const sim = tokenSimilarity(kTitle.tokens, pe.title.tokens);
      const shared = sharedNames(kTitle, pe.title);
      if (sim < MIN_BLOCK_SIMILARITY && shared < MIN_SHARED_ENTITIES) continue;

      const breakdown = scorePair(
        { title: kTitle, closeTime: ke.closeTime, category: ke.category },
        {
          title: pe.title,
          closeTime: pe.event.closeTime,
          category: pe.event.category,
        },
      );
      if (breakdown.total > 0) {
        out.push({ kalshiEvent: ke, polymarketEvent: pe.event, breakdown });
      }
    }
  }
  return out.sort((a, b) => b.breakdown.total - a.breakdown.total);
}

function withinCloseWindow(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return true; // unknown close time — don't block on it
  return Math.abs(a.getTime() - b.getTime()) <= CLOSE_WINDOW_DAYS * DAY_MS;
}
