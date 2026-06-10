CREATE TABLE "email_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"unsubscribed_at" timestamp with time zone,
	"unsubscribe_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source" text,
	CONSTRAINT "email_subscribers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "event_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kalshi_event_id" uuid NOT NULL,
	"polymarket_event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision,
	"method" text,
	"score_breakdown" jsonb,
	"pair_slug" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "event_matches_pair_slug_unique" UNIQUE("pair_slug")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_id" smallint NOT NULL,
	"external_id" text NOT NULL,
	"slug" text,
	"title" text NOT NULL,
	"category" text,
	"close_time" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"volume_24h" double precision,
	"raw" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now(),
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "market_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_match_id" uuid NOT NULL,
	"kalshi_market_id" uuid NOT NULL,
	"polymarket_market_id" uuid NOT NULL,
	"outcome_inverted" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"confidence" double precision
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"platform_id" smallint NOT NULL,
	"external_id" text NOT NULL,
	"question" text NOT NULL,
	"outcome_label" text,
	"yes_token_id" text,
	"no_token_id" text,
	"resolution_rules" text,
	"status" text DEFAULT 'open' NOT NULL,
	"close_time" timestamp with time zone,
	"volume" double precision,
	"volume_24h" double precision,
	"open_interest" double precision,
	"liquidity" double precision,
	"raw" jsonb,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platforms" (
	"id" smallint PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "platforms_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "price_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"market_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"yes_bid" double precision,
	"yes_ask" double precision,
	"no_bid" double precision,
	"no_ask" double precision,
	"last_price" double precision,
	"mid" double precision,
	"bid_depth_usd" double precision,
	"ask_depth_usd" double precision,
	"volume_24h" double precision
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"stats" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_kalshi_event_id_events_id_fk" FOREIGN KEY ("kalshi_event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_polymarket_event_id_events_id_fk" FOREIGN KEY ("polymarket_event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_links" ADD CONSTRAINT "market_links_event_match_id_event_matches_id_fk" FOREIGN KEY ("event_match_id") REFERENCES "public"."event_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_links" ADD CONSTRAINT "market_links_kalshi_market_id_markets_id_fk" FOREIGN KEY ("kalshi_market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_links" ADD CONSTRAINT "market_links_polymarket_market_id_markets_id_fk" FOREIGN KEY ("polymarket_market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_matches_pair_uq" ON "event_matches" USING btree ("kalshi_event_id","polymarket_event_id");--> statement-breakpoint
CREATE INDEX "event_matches_status_idx" ON "event_matches" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "events_platform_external_uq" ON "events" USING btree ("platform_id","external_id");--> statement-breakpoint
CREATE INDEX "events_status_close_idx" ON "events" USING btree ("status","close_time");--> statement-breakpoint
CREATE UNIQUE INDEX "market_links_pair_uq" ON "market_links" USING btree ("kalshi_market_id","polymarket_market_id");--> statement-breakpoint
CREATE INDEX "market_links_match_idx" ON "market_links" USING btree ("event_match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_platform_external_uq" ON "markets" USING btree ("platform_id","external_id");--> statement-breakpoint
CREATE INDEX "markets_event_idx" ON "markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "markets_status_volume_idx" ON "markets" USING btree ("status","volume_24h");--> statement-breakpoint
CREATE UNIQUE INDEX "price_snapshots_market_ts_uq" ON "price_snapshots" USING btree ("market_id","ts");--> statement-breakpoint
CREATE INDEX "price_snapshots_market_ts_idx" ON "price_snapshots" USING btree ("market_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_runs_job_started_idx" ON "sync_runs" USING btree ("job","started_at" DESC NULLS LAST);
--> statement-breakpoint
INSERT INTO "platforms" ("id", "slug", "name") VALUES (1, 'kalshi', 'Kalshi'), (2, 'polymarket', 'Polymarket') ON CONFLICT DO NOTHING;
