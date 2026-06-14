import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { syncRuns } from "./db/schema";
import { requireCronAuth } from "./config";

/**
 * Run `fn`, recording a sync_runs row for observability (visible at
 * /admin/health). Shared by the HTTP job wrapper and the admin "Run now" button.
 */
export async function recordJobRun(
  name: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<{ ok: true; stats: Record<string, unknown> } | { ok: false; error: string }> {
  const [run] = await db()
    .insert(syncRuns)
    .values({ job: name, startedAt: new Date() })
    .returning({ id: syncRuns.id });

  try {
    const stats = await fn();
    await db()
      .update(syncRuns)
      .set({ finishedAt: new Date(), ok: true, stats })
      .where(eq(syncRuns.id, run.id));
    return { ok: true, stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db()
      .update(syncRuns)
      .set({ finishedAt: new Date(), ok: false, error: message })
      .where(eq(syncRuns.id, run.id));
    return { ok: false, error: message };
  }
}

/**
 * Wrapper for all /api/jobs/* handlers: bearer-token auth, then recordJobRun
 * for the sync_runs observability row, returned as JSON.
 */
export async function runJob(
  req: Request,
  name: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const result = await recordJobRun(name, fn);
  return result.ok
    ? Response.json({ ok: true, job: name, stats: result.stats })
    : Response.json({ ok: false, job: name, error: result.error }, { status: 500 });
}
