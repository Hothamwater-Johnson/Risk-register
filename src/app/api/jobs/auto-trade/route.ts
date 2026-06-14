import { autoTradeOnce } from "@/lib/autoTrader";
import { runJob } from "@/lib/jobs";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Paper auto-trader cron (admin-only). Thin wrapper: bearer-token auth +
 * sync_runs logging via runJob; the actual close/open logic lives in
 * autoTradeOnce so the admin "Run now" button runs the exact same pass.
 */
export async function GET(req: Request) {
  return runJob(req, "auto-trade", autoTradeOnce);
}
