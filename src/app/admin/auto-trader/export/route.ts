import { getSessionCsv, hasAutoTraderAccess } from "@/lib/autoTrader";

export const dynamic = "force-dynamic";

// UTF-8 byte-order mark so Excel detects the encoding for non-ASCII titles.
const BOM = String.fromCharCode(0xfeff);

/**
 * Download a session's results as CSV (Excel / Google Sheets readable). Gated by
 * the same access as the dashboard. `?session=<id>` for an archived session;
 * omitted or `current` builds a live CSV from the bot's current trades.
 */
export async function GET(req: Request) {
  if (!(await hasAutoTraderAccess())) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sessionId = new URL(req.url).searchParams.get("session") ?? "current";
  const result = await getSessionCsv(sessionId);
  if (!result) return new Response("No such session", { status: 404 });

  return new Response(BOM + result.csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${result.name}.csv"`,
      "cache-control": "no-store",
    },
  });
}
