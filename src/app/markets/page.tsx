import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PlatformChip } from "@/components/ui";
import { PLATFORM } from "@/lib/db/schema";
import { searchMarkets, type MarketSearchRow } from "@/lib/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Browse markets" };

type Props = {
  searchParams: Promise<{ q?: string; matched?: string }>;
};

export default async function MarketsPage({ searchParams }: Props) {
  const { q, matched } = await searchParams;
  const matchedOnly = matched === "1";

  let rows: MarketSearchRow[] = [];
  let dbDown = false;
  try {
    rows = await searchMarkets({ q, matchedOnly, limit: 80 });
  } catch {
    dbDown = true;
  }

  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-xl font-bold tracking-tight">Browse markets</h1>
        <p className="mt-1 text-sm text-muted">
          Everything we track on both platforms, highest volume first.
        </p>
      </section>

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search markets…"
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {matchedOnly && <input type="hidden" name="matched" value="1" />}
        <button
          type="submit"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
        >
          Search
        </button>
      </form>

      <div className="flex gap-2 text-xs">
        <FilterLink href={buildHref(q, false)} active={!matchedOnly}>
          All markets
        </FilterLink>
        <FilterLink href={buildHref(q, true)} active={matchedOnly}>
          Matched on both platforms
        </FilterLink>
      </div>

      {dbDown ? (
        <EmptyState
          title="Data isn't flowing yet"
          hint="Once the database is connected and sync jobs run, markets appear here."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing found"
          hint={
            matchedOnly
              ? "No matched markets for that search — try all markets."
              : "Try a different search term."
          }
        />
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {rows.map((r) => (
            <MarketRow key={r.market.id} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function buildHref(q: string | undefined, matched: boolean): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (matched) params.set("matched", "1");
  const s = params.toString();
  return `/markets${s ? `?${s}` : ""}`;
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 font-medium ${
        active
          ? "bg-accent text-white"
          : "border border-border text-muted hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

function MarketRow({ row }: { row: MarketSearchRow }) {
  const platform =
    row.market.platformId === PLATFORM.kalshi ? "kalshi" : "polymarket";
  const inner = (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.market.question}</p>
        <p className="mt-0.5 text-xs text-muted">
          {row.event?.title && row.event.title !== row.market.question
            ? row.event.title
            : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {row.pairSlug && (
          <span className="rounded-md bg-positive/10 px-2 py-0.5 text-xs font-medium text-positive">
            both
          </span>
        )}
        <PlatformChip platform={platform} prob={null} />
      </div>
    </div>
  );
  return row.pairSlug ? (
    <Link href={`/e/${row.pairSlug}`} className="block hover:bg-background/50">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}
