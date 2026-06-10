import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * All prices are stored as probabilities in [0, 1] regardless of platform
 * (Kalshi cents are divided by 100 at ingest). Money amounts are USD.
 */

export const platforms = pgTable("platforms", {
  id: smallint("id").primaryKey(), // 1 = kalshi, 2 = polymarket
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
});

export const PLATFORM = { kalshi: 1, polymarket: 2 } as const;
export type PlatformSlug = keyof typeof PLATFORM;

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platformId: smallint("platform_id")
      .notNull()
      .references(() => platforms.id),
    externalId: text("external_id").notNull(), // kalshi event_ticker | gamma event id
    slug: text("slug"),
    title: text("title").notNull(),
    category: text("category"),
    closeTime: timestamp("close_time", { withTimezone: true }),
    status: text("status").notNull().default("open"),
    volume24h: doublePrecision("volume_24h"),
    raw: jsonb("raw"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("events_platform_external_uq").on(t.platformId, t.externalId),
    index("events_status_close_idx").on(t.status, t.closeTime),
  ],
);

export const markets = pgTable(
  "markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    platformId: smallint("platform_id")
      .notNull()
      .references(() => platforms.id),
    externalId: text("external_id").notNull(), // kalshi market ticker | polymarket condition id
    question: text("question").notNull(),
    outcomeLabel: text("outcome_label"), // e.g. candidate name in multi-outcome events
    yesTokenId: text("yes_token_id"), // polymarket CLOB token ids; null for kalshi
    noTokenId: text("no_token_id"),
    resolutionRules: text("resolution_rules"),
    status: text("status").notNull().default("open"),
    closeTime: timestamp("close_time", { withTimezone: true }),
    volume: doublePrecision("volume"),
    volume24h: doublePrecision("volume_24h"),
    openInterest: doublePrecision("open_interest"),
    liquidity: doublePrecision("liquidity"),
    raw: jsonb("raw"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("markets_platform_external_uq").on(t.platformId, t.externalId),
    index("markets_event_idx").on(t.eventId),
    index("markets_status_volume_idx").on(t.status, t.volume24h),
  ],
);

export const priceSnapshots = pgTable(
  "price_snapshots",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    yesBid: doublePrecision("yes_bid"),
    yesAsk: doublePrecision("yes_ask"),
    noBid: doublePrecision("no_bid"),
    noAsk: doublePrecision("no_ask"),
    lastPrice: doublePrecision("last_price"),
    mid: doublePrecision("mid"),
    bidDepthUsd: doublePrecision("bid_depth_usd"), // $ executable within top 5 levels
    askDepthUsd: doublePrecision("ask_depth_usd"),
    volume24h: doublePrecision("volume_24h"),
  },
  (t) => [
    uniqueIndex("price_snapshots_market_ts_uq").on(t.marketId, t.ts),
    index("price_snapshots_market_ts_idx").on(t.marketId, t.ts.desc()),
  ],
);

export const MATCH_STATUS = [
  "candidate",
  "llm_confirmed",
  "confirmed",
  "rejected",
] as const;
export type MatchStatus = (typeof MATCH_STATUS)[number];

export const eventMatches = pgTable(
  "event_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kalshiEventId: uuid("kalshi_event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    polymarketEventId: uuid("polymarket_event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status").notNull().$type<MatchStatus>(),
    confidence: doublePrecision("confidence"), // 0..1
    method: text("method"), // 'fuzzy' | 'llm' | 'manual'
    scoreBreakdown: jsonb("score_breakdown"),
    pairSlug: text("pair_slug").unique(), // for /e/[pairSlug]
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("event_matches_pair_uq").on(t.kalshiEventId, t.polymarketEventId),
    index("event_matches_status_idx").on(t.status),
  ],
);

export const marketLinks = pgTable(
  "market_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventMatchId: uuid("event_match_id")
      .notNull()
      .references(() => eventMatches.id, { onDelete: "cascade" }),
    kalshiMarketId: uuid("kalshi_market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    polymarketMarketId: uuid("polymarket_market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    outcomeInverted: boolean("outcome_inverted").notNull().default(false), // YES here == NO there
    status: text("status").notNull().default("candidate"),
    confidence: doublePrecision("confidence"),
  },
  (t) => [
    uniqueIndex("market_links_pair_uq").on(t.kalshiMarketId, t.polymarketMarketId),
    index("market_links_match_idx").on(t.eventMatchId),
  ],
);

export type PaperSide = "yes" | "no";
export type PaperCloseReason = "manual" | "settled_yes" | "settled_no";

/**
 * Paper-trading simulator: virtual fills recorded against our own snapshots
 * so strategies can be tested without money. Leg sides/prices are stored in
 * each venue's own terms (what you would actually click on that platform);
 * `marketLinks.outcomeInverted` is applied when opening and settling, never
 * when valuing a leg against its own venue's snapshot.
 */
export const paperTrades = pgTable(
  "paper_trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketLinkId: uuid("market_link_id")
      .notNull()
      .references(() => marketLinks.id, { onDelete: "cascade" }),
    // Entry legs: null side = no position on that platform.
    kalshiSide: text("kalshi_side").$type<PaperSide>(),
    kalshiEntry: doublePrecision("kalshi_entry"), // prob paid per share
    polySide: text("poly_side").$type<PaperSide>(),
    polyEntry: doublePrecision("poly_entry"),
    shares: doublePrecision("shares").notNull(),
    entryFeesUsd: doublePrecision("entry_fees_usd").notNull().default(0),
    // What the dashboard claimed at entry — the baseline for "did it work?".
    expectedEdge: doublePrecision("expected_edge"), // net edge/share, arbs only
    entryDisagreement: doublePrecision("entry_disagreement"),
    thinBookAtEntry: boolean("thin_book_at_entry").notNull().default(false),
    thesis: text("thesis"),
    status: text("status").notNull().default("open"), // 'open' | 'closed'
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    exitKalshi: doublePrecision("exit_kalshi"), // per-share value received
    exitPoly: doublePrecision("exit_poly"),
    exitFeesUsd: doublePrecision("exit_fees_usd"),
    realizedPnlUsd: doublePrecision("realized_pnl_usd"),
    closeReason: text("close_reason").$type<PaperCloseReason>(),
  },
  (t) => [
    index("paper_trades_status_idx").on(t.status, t.openedAt.desc()),
    index("paper_trades_link_idx").on(t.marketLinkId),
  ],
);

export const emailSubscribers = pgTable("email_subscribers", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(), // lowercased before insert
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  unsubscribeToken: uuid("unsubscribe_token").notNull().defaultRandom(),
  source: text("source"),
});

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    job: text("job").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ok: boolean("ok"),
    stats: jsonb("stats"),
    error: text("error"),
  },
  (t) => [index("sync_runs_job_started_idx").on(t.job, t.startedAt.desc())],
);

export type Event = typeof events.$inferSelect;
export type Market = typeof markets.$inferSelect;
export type PriceSnapshot = typeof priceSnapshots.$inferSelect;
export type EventMatch = typeof eventMatches.$inferSelect;
export type MarketLink = typeof marketLinks.$inferSelect;
export type PaperTrade = typeof paperTrades.$inferSelect;
