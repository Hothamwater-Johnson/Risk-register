CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "profiles_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "result" text;--> statement-breakpoint
ALTER TABLE "paper_trades" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "paper_trades" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
ALTER TABLE "paper_trades" ADD CONSTRAINT "paper_trades_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_trades_profile_idx" ON "paper_trades" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paper_trades_idem_uq" ON "paper_trades" USING btree ("idempotency_key");