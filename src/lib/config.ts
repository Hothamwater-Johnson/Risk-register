/**
 * Central runtime config. Everything likely to change (API base URLs, fee
 * coefficients, polling caps) lives here or in env vars — not in code paths.
 */

export const KALSHI_BASE_URL =
  process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

export const GAMMA_BASE_URL =
  process.env.GAMMA_BASE_URL ?? "https://gamma-api.polymarket.com";

export const CLOB_BASE_URL =
  process.env.CLOB_BASE_URL ?? "https://clob.polymarket.com";

export const USER_AGENT =
  process.env.APP_USER_AGENT ?? "spread-scout/0.1 (+contact: set APP_CONTACT_EMAIL)";

/** Max events ingested per platform per catalog sync run. */
export const CATALOG_SYNC_MAX_EVENTS = Number(
  process.env.CATALOG_SYNC_MAX_EVENTS ?? 2000,
);

/** Top-N markets per platform (by 24h volume) snapshotted even when unmatched. */
export const SNAPSHOT_TOP_N = Number(process.env.SNAPSHOT_TOP_N ?? 200);

/** Minimum executable dollars on both legs before an arb is shown as real. */
export const MIN_EXECUTABLE_USD = Number(process.env.MIN_EXECUTABLE_USD ?? 50);

/** Heuristic score below which candidate pairs are not sent to the LLM. */
export const MATCH_LLM_THRESHOLD = 0.5;
/** Thresholds for auto-confirming a match without human review. */
export const MATCH_AUTO_CONFIRM = { llm: 0.9, heuristic: 0.7 };

export const ANTHROPIC_MATCH_MODEL =
  process.env.ANTHROPIC_MATCH_MODEL ?? "claude-haiku-4-5-20251001";

export function requireCronAuth(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export function isAdmin(token: string | undefined | null): boolean {
  const expected = process.env.ADMIN_TOKEN;
  return Boolean(expected && token && token === expected);
}
