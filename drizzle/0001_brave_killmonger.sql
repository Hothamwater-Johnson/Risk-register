CREATE TABLE "paper_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_link_id" uuid NOT NULL,
	"kalshi_side" text,
	"kalshi_entry" double precision,
	"poly_side" text,
	"poly_entry" double precision,
	"shares" double precision NOT NULL,
	"entry_fees_usd" double precision DEFAULT 0 NOT NULL,
	"expected_edge" double precision,
	"entry_disagreement" double precision,
	"thin_book_at_entry" boolean DEFAULT false NOT NULL,
	"thesis" text,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now(),
	"closed_at" timestamp with time zone,
	"exit_kalshi" double precision,
	"exit_poly" double precision,
	"exit_fees_usd" double precision,
	"realized_pnl_usd" double precision,
	"close_reason" text
);
--> statement-breakpoint
ALTER TABLE "paper_trades" ADD CONSTRAINT "paper_trades_market_link_id_market_links_id_fk" FOREIGN KEY ("market_link_id") REFERENCES "public"."market_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_trades_status_idx" ON "paper_trades" USING btree ("status","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "paper_trades_link_idx" ON "paper_trades" USING btree ("market_link_id");