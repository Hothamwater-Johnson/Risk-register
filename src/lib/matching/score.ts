import {
  NormalizedTitle,
  sharedNames,
  tokenSimilarity,
} from "./normalize";

export type ScoreInput = {
  title: NormalizedTitle;
  closeTime: Date | null;
  category: string | null;
};

export type ScoreBreakdown = {
  tokenSim: number;
  closeProximity: number;
  entityOverlap: number;
  categoryAgreement: number;
  numericVeto: boolean;
  total: number;
};

const DAY_MS = 86_400_000;

/**
 * Heuristic match score in [0,1]. Precision-critical rule: if both titles
 * contain numeric thresholds and they differ ("BTC above 100k" vs "110k"),
 * the pair scores 0 regardless of how similar the words are.
 */
export function scorePair(a: ScoreInput, b: ScoreInput): ScoreBreakdown {
  const numericVeto = hasNumericConflict(a.title, b.title);

  const tokenSim = tokenSimilarity(a.title.tokens, b.title.tokens);

  let closeProximity = 0.5; // unknown close times — neutral
  if (a.closeTime && b.closeTime) {
    const days = Math.abs(a.closeTime.getTime() - b.closeTime.getTime()) / DAY_MS;
    closeProximity = days <= 1 ? 1 : days <= 3 ? 0.7 : days <= 5 ? 0.4 : 0;
  }

  const shared = sharedNames(a.title, b.title);
  const maxNames = Math.max(a.title.names.size, b.title.names.size);
  const entityOverlap =
    maxNames === 0 ? 0.5 : Math.min(shared / Math.min(maxNames, 3), 1);

  const categoryAgreement = agreeCategory(a.category, b.category);

  const total = numericVeto
    ? 0
    : 0.5 * tokenSim +
      0.15 * closeProximity +
      0.25 * entityOverlap +
      0.1 * categoryAgreement;

  return { tokenSim, closeProximity, entityOverlap, categoryAgreement, numericVeto, total };
}

function hasNumericConflict(a: NormalizedTitle, b: NormalizedTitle): boolean {
  if (a.numbers.length === 0 || b.numbers.length === 0) return false;
  // Every number on the smaller side must appear on the other (±0.1% slack).
  const [small, large] =
    a.numbers.length <= b.numbers.length ? [a.numbers, b.numbers] : [b.numbers, a.numbers];
  return !small.every((n) =>
    large.some((m) => Math.abs(m - n) <= Math.abs(n) * 0.001),
  );
}

function agreeCategory(a: string | null, b: string | null): number {
  if (!a || !b) return 0.5;
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  if (na === nb) return 1;
  // Platforms use different taxonomies; loose containment counts.
  return na.includes(nb) || nb.includes(na) ? 0.8 : 0;
}
