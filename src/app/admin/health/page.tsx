import type { Metadata } from "next";
import { desc } from "drizzle-orm";
import { isAdmin } from "@/lib/config";
import { db } from "@/lib/db/client";
import { syncRuns } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Job health", robots: "noindex" };

type Props = { searchParams: Promise<{ token?: string }> };

export default async function HealthPage({ searchParams }: Props) {
  const { token } = await searchParams;
  if (!isAdmin(token)) {
    return (
      <p className="py-20 text-center text-sm text-muted">
        Add ?token=ADMIN_TOKEN to the URL.
      </p>
    );
  }

  const runs = await db()
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(50);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold tracking-tight">Job health</h1>
      <div className="divide-y divide-border rounded-xl border border-border bg-card text-xs">
        {runs.length === 0 && (
          <p className="px-4 py-6 text-center text-muted">
            No job runs yet. Trigger /api/jobs/sync-catalog with the cron secret.
          </p>
        )}
        {runs.map((r) => (
          <div key={r.id} className="px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                {r.ok === true ? "✅" : r.ok === false ? "❌" : "⏳"} {r.job}
              </span>
              <span className="font-mono text-muted">
                {r.startedAt.toISOString().slice(0, 16).replace("T", " ")} ·{" "}
                {r.finishedAt
                  ? `${((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(1)}s`
                  : "running"}
              </span>
            </div>
            {r.error && <p className="mt-1 text-negative">{r.error}</p>}
            {r.stats != null && (
              <p className="mt-1 break-all font-mono text-muted">
                {JSON.stringify(r.stats)}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
