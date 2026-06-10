import type { Metadata } from "next";
import Link from "next/link";
import { LEARN_PAGES } from "@/lib/explain/copy";

export const metadata: Metadata = {
  title: "Learn",
  description:
    "Prediction markets explained in plain English: implied probability, spreads, arbitrage, and fees.",
};

export default function LearnIndexPage() {
  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-xl font-bold tracking-tight">
          Prediction markets, in plain English
        </h1>
        <p className="mt-1 text-sm text-muted">
          Five short reads that cover everything the numbers on this site mean.
        </p>
      </section>
      <div className="space-y-3">
        {Object.entries(LEARN_PAGES).map(([slug, page]) => (
          <Link
            key={slug}
            href={`/learn/${slug}`}
            className="block rounded-xl border border-border bg-card p-4 hover:border-accent"
          >
            <h2 className="text-sm font-semibold">{page.title}</h2>
            <p className="mt-1 text-xs text-muted">{page.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
