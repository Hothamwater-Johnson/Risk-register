import Link from "next/link";
import { EmailSignup } from "@/components/EmailSignup";
import { EmptyState, PairCard } from "@/components/ui";
import { explainMover, pct } from "@/lib/explain/copy";
import { getActivePairs, getMovers, type Mover, type PairView } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let pairs: PairView[] = [];
  let movers: Mover[] = [];
  let dbDown = false;
  try {
    [pairs, movers] = await Promise.all([getActivePairs(15), getMovers(8)]);
  } catch {
    dbDown = true;
  }

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-xl font-bold tracking-tight">
          Where prediction markets disagree
        </h1>
        <p className="mt-1 text-sm text-muted">
          The same events, priced on Kalshi and Polymarket — and what the gaps
          actually mean.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Biggest gaps right now
        </h2>
        {dbDown ? (
          <EmptyState
            title="Data isn't flowing yet"
            hint="The database isn't reachable. Once DATABASE_URL is set and the sync jobs run, gaps show up here."
          />
        ) : pairs.length === 0 ? (
          <EmptyState
            title="No matched events yet"
            hint="The matching engine runs every few hours. As soon as the same event is found on both platforms, its gap appears here."
          />
        ) : (
          pairs.map((p) => <PairCard key={p.match.id} pair={p} />)
        )}
      </section>

      {movers.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Big movers, last 24h
          </h2>
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {movers.map((m) => (
              <MoverRow key={m.market.id} mover={m} />
            ))}
          </div>
        </section>
      )}

      <EmailSignup source="home" />

      <section className="text-xs text-muted">
        New to prediction markets?{" "}
        <Link href="/learn" className="text-accent underline">
          Start with the 5-minute glossary
        </Link>{" "}
        — implied probability, spreads, and why these gaps exist.
      </section>
    </div>
  );
}

function MoverRow({ mover }: { mover: Mover }) {
  const up = mover.change > 0;
  const inner = (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{mover.market.question}</p>
        <p className="mt-0.5 text-xs text-muted">
          {explainMover(mover.market.question, mover.change).split("—")[1]?.trim() ??
            ""}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`font-mono text-sm font-bold ${up ? "text-positive" : "text-negative"}`}>
          {up ? "▲" : "▼"} {Math.abs(Math.round(mover.change * 100))}pt
        </p>
        <p className="font-mono text-xs text-muted">
          {pct(mover.mid24hAgo)} → {pct(mover.midNow)}
        </p>
      </div>
    </div>
  );
  return mover.pairSlug ? (
    <Link href={`/e/${mover.pairSlug}`} className="block hover:bg-background/50">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}
