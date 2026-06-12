/**
 * One-off live check backing the auto-settlement design (manual §2.5 spirit):
 * what does Kalshi actually report for settled markets? Read-only; no DB.
 * Run: pnpm dlx tsx scripts/check-kalshi-settlement.ts
 */
const BASE = "https://api.elections.kalshi.com/trade-api/v2";

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

type RawMarket = Record<string, unknown>;

function brief(m: RawMarket) {
  return {
    ticker: m.ticker,
    status: m.status,
    result: m.result,
    can_close_early: m.can_close_early,
    close_time: m.close_time,
    settlement_value_dollars: m.settlement_value_dollars,
    settlement_timer_seconds: m.settlement_timer_seconds,
  };
}

async function main() {
  // 1) Does /markets accept a settled-status filter, and what do rows look like?
  for (const status of ["settled", "finalized", "closed"]) {
    try {
      const json = (await getJson(
        `${BASE}/markets?status=${status}&limit=20`,
      )) as { markets?: RawMarket[] };
      const ms = json.markets ?? [];
      const statuses = [...new Set(ms.map((m) => m.status))];
      const results = [...new Set(ms.map((m) => m.result))];
      console.log(
        `status=${status}: ${ms.length} markets; status values=${JSON.stringify(statuses)}; result values=${JSON.stringify(results)}`,
      );
      if (ms.length > 0) console.log("  sample:", JSON.stringify(brief(ms[0])));
    } catch (err) {
      console.log(`status=${status}: ERROR ${(err as Error).message}`);
    }
  }

  // 2) Distribution of result values across a bigger settled sample, and do
  //    any non-binary results (void/scratch/partial) appear?
  const big = (await getJson(`${BASE}/markets?status=settled&limit=500`)) as {
    markets?: RawMarket[];
  };
  const ms = big.markets ?? [];
  const byResult = new Map<string, number>();
  for (const m of ms) {
    const r = String(m.result ?? "<absent>");
    byResult.set(r, (byResult.get(r) ?? 0) + 1);
  }
  console.log(
    `\nsettled sample n=${ms.length}; result distribution:`,
    JSON.stringify(Object.fromEntries(byResult)),
  );
  const weird = ms.filter((m) => m.result !== "yes" && m.result !== "no");
  console.log(
    `non-yes/no results: ${weird.length}`,
    weird.slice(0, 5).map((m) => JSON.stringify(brief(m))).join("\n  "),
  );

  // 3) Critical: does GET /markets?tickers= return SETTLED tickers? (sync-catalog
  //    only sees open events, so the settle job must be able to fetch by ticker.)
  const settledTickers = ms.slice(0, 5).map((m) => String(m.ticker));
  if (settledTickers.length > 0) {
    const byTicker = (await getJson(
      `${BASE}/markets?tickers=${settledTickers.join(",")}&limit=100`,
    )) as { markets?: RawMarket[] };
    const got = byTicker.markets ?? [];
    console.log(
      `\nmarkets?tickers= with settled tickers: asked ${settledTickers.length}, got ${got.length}`,
    );
    for (const m of got) console.log("  ", JSON.stringify(brief(m)));
  }

  // 4) What does a single settled market look like via GET /markets/{ticker}?
  if (settledTickers[0]) {
    const single = (await getJson(
      `${BASE}/markets/${encodeURIComponent(settledTickers[0])}`,
    )) as { market?: RawMarket };
    console.log(
      `\nGET /markets/{ticker} settled sample full keys:`,
      single.market ? Object.keys(single.market).sort().join(", ") : "none",
    );
    if (single.market) console.log("  brief:", JSON.stringify(brief(single.market)));
  }
}

main().catch((err) => {
  console.error("UNCAUGHT:", err);
  process.exit(1);
});
