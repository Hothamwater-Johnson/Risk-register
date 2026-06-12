/**
 * Apply one migration file over the Neon HTTP driver. Cloud containers block
 * TCP 5432 (no psql) and drizzle-kit migrate hangs with neon-http, so we
 * split on drizzle's statement-breakpoint markers and run each statement.
 * MUST use sql.query(): in @neondatabase/serverless v1, sql.unsafe() builds a
 * fragment and silently executes nothing when awaited (see errors.md).
 *
 * Run: DATABASE_URL=... pnpm dlx tsx scripts/apply-migration.ts drizzle/0002_profiles_settlement.sql
 */
import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: apply-migration.ts <path-to-sql-file>");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const sql = neon(url);
  const statements = readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const [i, stmt] of statements.entries()) {
    process.stdout.write(`[${i + 1}/${statements.length}] ${stmt.slice(0, 72).replace(/\s+/g, " ")}… `);
    await sql.query(stmt);
    console.log("ok");
  }
  console.log(`Applied ${statements.length} statements from ${file}`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
