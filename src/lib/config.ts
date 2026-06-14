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

/**
 * Auto-trader (paper, admin-only). Off by default so arming is explicit. The
 * bot opens arbs whose after-fee edge clears MIN_EDGE and whose book isn't thin,
 * and closes early only on the explicit triggers below — otherwise it holds to
 * settlement (optimal for a clean arb: legs sum to $1 with no exit fees).
 */
export const AUTO_TRADER_ENABLED = process.env.AUTO_TRADER_ENABLED === "1";
/** Minimum after-fee net edge per share before the bot opens (stricter than display). */
export const AUTO_TRADER_MIN_EDGE = Number(process.env.AUTO_TRADER_MIN_EDGE ?? 0.02);
/** Target cost basis (USD, incl. fees) per opened position, before caps. */
export const AUTO_TRADER_STAKE_USD = Number(process.env.AUTO_TRADER_STAKE_USD ?? 100);
/** Hard cap on simultaneously open bot positions. */
export const AUTO_TRADER_MAX_OPEN = Number(process.env.AUTO_TRADER_MAX_OPEN ?? 20);
/**
 * Don't open arbs that resolve more than this many days out — long-dated
 * positions (e.g. 2028 nominee markets) freeze capital until settlement and
 * never inform the capture ratio in time. <= 0 disables the horizon limit.
 */
export const AUTO_TRADER_MAX_DAYS_TO_RESOLVE = Number(
  process.env.AUTO_TRADER_MAX_DAYS_TO_RESOLVE ?? 90,
);
/**
 * Early-close thresholds on an open position's unrealized (mark-to-market) P&L.
 * BOTH default to 0 = disabled, because marking a two-leg *hedged* arb against
 * the bid side mid-life just reflects the book's bid/ask spread — a real arb
 * pays $1/share at settlement, so closing early only realizes that spread (plus
 * a second round of taker fees) as a loss. Default behavior is therefore: hold
 * to settlement (settle-paper closes them). Set > 0 only to opt back in.
 */
export const AUTO_TRADER_TAKE_PROFIT_USD = Number(
  process.env.AUTO_TRADER_TAKE_PROFIT_USD ?? 0,
);
export const AUTO_TRADER_STOP_USD = Number(process.env.AUTO_TRADER_STOP_USD ?? 0);
/** Bank a positive mark on rules-differ pairs (real basis risk); default on. */
export const AUTO_TRADER_CLOSE_RULES_DIFFER =
  process.env.AUTO_TRADER_CLOSE_RULES_DIFFER !== "0";
/**
 * Simple shared password for the /admin/auto-trader dashboard, so it's reachable
 * from the main nav without pasting the long ADMIN_TOKEN. The page is read-only
 * (no mutations), so this is a convenience gate, not a security boundary — the
 * ADMIN_TOKEN path still works too. Override in prod via AUTO_TRADER_PASSWORD.
 */
export const AUTO_TRADER_PASSWORD = process.env.AUTO_TRADER_PASSWORD ?? "hotham";

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
