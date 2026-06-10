import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let _db: ReturnType<typeof createDb> | null = null;

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return drizzle(neon(url), { schema });
}

/** Lazy singleton so importing this module never throws at build time. */
export function db() {
  _db ??= createDb();
  return _db;
}

export type Db = ReturnType<typeof db>;
