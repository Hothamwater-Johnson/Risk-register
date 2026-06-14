CREATE TABLE "trading_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text DEFAULT 'paused' NOT NULL,
	"label" text,
	"trade_count" integer,
	"stats" jsonb,
	"csv" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "trading_sessions_ended_started_idx" ON "trading_sessions" USING btree ("ended_at","started_at" DESC NULLS LAST);