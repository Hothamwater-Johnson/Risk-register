/**
 * Title normalization + entity extraction for cross-platform event matching.
 * The goal is recall at candidate stage: make "Will BTC hit $100K by June 30?"
 * and "Bitcoin above 100k on 2026-06-30" look similar.
 */

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

const STOPWORDS = new Set([
  "will", "the", "a", "an", "be", "by", "in", "on", "at", "of", "to", "or",
  "and", "is", "are", "for", "before", "after", "during", "this", "what",
  "who", "when", "how", "many", "much", "do", "does", "happen", "win", "wins",
]);

/** "$100k" → 100000, "1.5m" → 1500000, "100,000" → 100000 */
function expandNumber(raw: string): number | null {
  const m = raw
    .toLowerCase()
    .replace(/[$,]/g, "")
    .match(/^(\d+(?:\.\d+)?)(k|m|b|bn|t)?$/);
  if (!m) return null;
  const base = Number(m[1]);
  const mult =
    { k: 1e3, m: 1e6, b: 1e9, bn: 1e9, t: 1e12 }[m[2] ?? ""] ?? 1;
  return base * mult;
}

export type NormalizedTitle = {
  tokens: Set<string>;
  /** Numeric thresholds found in the title (expanded: 100k → 100000). */
  numbers: number[];
  /** Years (2024-2039) mentioned. */
  years: number[];
  /** Months mentioned (1-12). */
  months: number[];
  /** Proper-noun-ish entities from the RAW title (capitalized words, tickers). */
  names: Set<string>;
};

export function normalizeTitle(rawTitle: string): NormalizedTitle {
  const names = new Set<string>();
  // Capitalized words / ALLCAPS tickers from the raw title, skipping the
  // leading word (titles are sentence-cased).
  for (const m of rawTitle.matchAll(/(?<!^)(?<![.?!]\s)\b([A-Z][a-zA-Z]{1,}|[A-Z]{2,6})\b/g)) {
    const w = m[1].toLowerCase();
    if (!STOPWORDS.has(w)) names.add(w);
  }

  const cleaned = rawTitle
    .toLowerCase()
    .replace(/['’"”“]/g, "")
    .replace(/[^a-z0-9$.,%\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = new Set<string>();
  const numbers: number[] = [];
  const years: number[] = [];
  const months: number[] = [];

  for (const word of cleaned.split(" ")) {
    if (!word) continue;
    const num = expandNumber(word);
    if (num !== null) {
      if (num >= 2024 && num <= 2039 && Number.isInteger(num)) {
        years.push(num);
      } else {
        numbers.push(num);
      }
      tokens.add(String(num));
      continue;
    }
    const bare = word.replace(/[.,%$-]/g, "");
    if (!bare) continue;
    if (MONTHS[bare] !== undefined) {
      months.push(MONTHS[bare]);
      tokens.add(`month${MONTHS[bare]}`);
      continue;
    }
    if (!STOPWORDS.has(bare) && bare.length > 1) tokens.add(bare);
  }

  return { tokens, numbers, years, months, names };
}

/** Jaccard similarity over token sets. */
export function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function sharedNames(a: NormalizedTitle, b: NormalizedTitle): number {
  let n = 0;
  for (const name of a.names) if (b.names.has(name)) n++;
  return n;
}
