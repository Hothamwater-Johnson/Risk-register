/**
 * Manual §2.5 spot-check: exercise every public-API client against live
 * endpoints and report whether the zod schemas hold and the data looks sane.
 * Read-only; no database required. Run: pnpm dlx tsx scripts/validate-live-apis.ts
 */
import {
  getKalshiEventsPage,
  getKalshiMarketsByTickers,
  getKalshiOrderbook,
  getKalshiCandlesticks,
} from "../src/lib/kalshi/client";
import { getGammaEventsPage, yesNoTokenIds } from "../src/lib/polymarket/gamma";
import {
  getClobBooks,
  getClobBook,
  getClobPriceHistory,
  summarizeBook,
} from "../src/lib/polymarket/clob";

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

async function main() {
  // --- Kalshi ---
  const first = await getKalshiEventsPage({ limit: 50, withNestedMarkets: true });
  check(
    "kalshi events",
    first.events.length > 0 && !!first.cursor,
    `${first.events.length} events, cursor=${first.cursor ? "yes" : "none"}`,
  );
  const withMarkets = first.events.filter((e) => (e.markets?.length ?? 0) > 0);
  check(
    "kalshi nested markets",
    withMarkets.length > 0,
    `${withMarkets.length}/${first.events.length} events have nested markets`,
  );

  // Paginate until we find actively traded markets (default order buries them).
  let events = first.events;
  let cursor = first.cursor;
  let sampleMarkets: typeof events[number]["markets"] & {} = [];
  const allEvents = [...events];
  for (let page = 0; page < 10 && sampleMarkets.length < 5; page++) {
    sampleMarkets = allEvents
      .flatMap((e) => e.markets ?? [])
      .filter((m) => m.status === "active" && (m.volume_24h_fp ?? 0) > 0)
      .slice(0, 5);
    if (sampleMarkets.length >= 5 || !cursor) break;
    const next = await getKalshiEventsPage({
      limit: 50,
      withNestedMarkets: true,
      cursor,
    });
    allEvents.push(...next.events);
    cursor = next.cursor;
  }
  events = allEvents;
  check(
    "kalshi market fields",
    sampleMarkets.length > 0 &&
      sampleMarkets.every(
        (m) =>
          m.yes_bid_dollars !== null &&
          m.yes_bid_dollars >= 0 &&
          m.yes_bid_dollars <= 1 &&
          m.yes_ask_dollars !== null &&
          m.yes_ask_dollars >= 0 &&
          m.yes_ask_dollars <= 1,
      ),
    sampleMarkets
      .map((m) => `${m.ticker} bid=${m.yes_bid_dollars} ask=${m.yes_ask_dollars} v24=${m.volume_24h_fp}`)
      .join(" | ") || "no active markets in sample",
  );

  const tickers = sampleMarkets.map((m) => m.ticker);
  if (tickers.length > 0) {
    const fetched = await getKalshiMarketsByTickers(tickers);
    check(
      "kalshi markets-by-tickers",
      fetched.length === tickers.length,
      `asked ${tickers.length}, got ${fetched.length}`,
    );
    const ob = await getKalshiOrderbook(tickers[0]);
    check(
      "kalshi orderbook",
      ob.yes.length + ob.no.length > 0 &&
        [...ob.yes, ...ob.no].every(([p, q]) => p >= 0 && p <= 1 && q >= 0),
      `${tickers[0]}: yes=${ob.yes.length} levels, no=${ob.no.length} levels, top yes=${JSON.stringify(ob.yes[0])}`,
    );
    const ev = events.find((e) =>
      (e.markets ?? []).some((m) => m.ticker === tickers[0]),
    );
    if (ev?.series_ticker) {
      const now = Math.floor(Date.now() / 1000);
      const candles = await getKalshiCandlesticks({
        seriesTicker: ev.series_ticker,
        marketTicker: tickers[0],
        startTs: now - 86400,
        endTs: now,
        periodIntervalMinutes: 60,
      });
      check(
        "kalshi candlesticks",
        candles.length > 0 && candles.every((c) => c.prob >= 0 && c.prob <= 1),
        `${candles.length} candles, last prob=${candles.at(-1)?.prob}`,
      );
    }
  }

  // --- Polymarket Gamma ---
  const gammaEvents = await getGammaEventsPage({ limit: 25 });
  check("gamma events", gammaEvents.length > 0, `${gammaEvents.length} events`);
  const gMarkets = gammaEvents
    .flatMap((e) => e.markets)
    .filter((m) => m.active && !m.closed && m.clobTokenIds.length >= 2);
  check(
    "gamma market parsing",
    gMarkets.length > 0 &&
      gMarkets
        .slice(0, 5)
        .every(
          (m) =>
            m.outcomes.length >= 2 &&
            (m.bestBid === null || (m.bestBid >= 0 && m.bestBid <= 1)),
        ),
    gMarkets
      .slice(0, 3)
      .map(
        (m) =>
          `"${m.question.slice(0, 40)}" outcomes=${JSON.stringify(m.outcomes)} bid=${m.bestBid}`,
      )
      .join(" | "),
  );

  // --- Polymarket CLOB ---
  const tokenPairs = gMarkets.slice(0, 5).map((m) => yesNoTokenIds(m));
  const yesTokens = tokenPairs.map((t) => t.yes).filter((t): t is string => !!t);
  const books = await getClobBooks(yesTokens);
  check(
    "clob batch books",
    books.size > 0,
    `asked ${yesTokens.length}, got ${books.size} books`,
  );
  if (yesTokens.length > 0) {
    const book = await getClobBook(yesTokens[0]);
    const summary = summarizeBook(book);
    check(
      "clob single book + summary",
      summary.mid !== null && summary.mid > 0 && summary.mid < 1,
      `bid=${summary.bestBid} ask=${summary.bestAsk} mid=${summary.mid} askDepth=$${summary.askDepthUsd.toFixed(0)}`,
    );
    const now = Math.floor(Date.now() / 1000);
    const hist = await getClobPriceHistory({
      tokenId: yesTokens[0],
      startTs: now - 86400,
      endTs: now,
      fidelityMinutes: 60,
    });
    check(
      "clob price history",
      hist.length > 0 && hist.every((h) => h.prob >= 0 && h.prob <= 1),
      `${hist.length} points, last=${hist.at(-1)?.prob}`,
    );
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("UNCAUGHT:", err);
  process.exit(1);
});
