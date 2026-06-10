import { isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { emailSubscribers } from "@/lib/db/schema";
import { chunk } from "@/lib/http";
import { runJob } from "@/lib/jobs";
import { cents, explainDisagreement, explainMover, pct } from "@/lib/explain/copy";
import { getActivePairs, getMovers } from "@/lib/queries";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Weekly digest: top gaps + top movers, same plain-English copy as the site,
 * sent via Resend's REST API (no SDK dependency). Skips cleanly when
 * RESEND_API_KEY isn't configured so the cron can be armed before email is.
 */
export async function GET(req: Request) {
  return runJob(req, "digest", async () => {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.DIGEST_FROM_EMAIL;
    if (!apiKey || !from) {
      return { skipped: "RESEND_API_KEY or DIGEST_FROM_EMAIL not set" };
    }

    const [pairs, movers, subscribers] = await Promise.all([
      getActivePairs(5),
      getMovers(5),
      db()
        .select()
        .from(emailSubscribers)
        .where(isNull(emailSubscribers.unsubscribedAt)),
    ]);

    if (subscribers.length === 0) return { sent: 0, reason: "no subscribers" };

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
    const html = renderDigest(pairs, movers, baseUrl);

    let sent = 0;
    for (const batch of chunk(subscribers, 100)) {
      const res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          batch.map((s) => ({
            from,
            to: [s.email],
            subject: "This week's biggest prediction market gaps",
            html: html.replace(
              "__UNSUB__",
              `${baseUrl}/api/unsubscribe?token=${s.unsubscribeToken}`,
            ),
          })),
        ),
      });
      if (!res.ok) {
        throw new Error(`Resend batch failed: ${res.status} ${await res.text()}`);
      }
      sent += batch.length;
    }
    return { sent, pairs: pairs.length, movers: movers.length };
  });
}

function renderDigest(
  pairs: Awaited<ReturnType<typeof getActivePairs>>,
  movers: Awaited<ReturnType<typeof getMovers>>,
  baseUrl: string,
): string {
  const gapItems = pairs
    .filter((p) => p.maxDisagreement !== null)
    .map((p) => {
      const k = p.links[0]?.spread.kalshiMid;
      const pm = p.links[0]?.spread.polymarketMid;
      const explainer =
        k != null && pm != null ? explainDisagreement(k, pm) : "";
      return `<li style="margin-bottom:16px">
        <a href="${baseUrl}/e/${p.match.pairSlug}" style="font-weight:600;color:#111">${escapeHtml(p.kalshiEvent.title)}</a>
        <div style="color:#444;font-size:14px">Gap: ${cents(p.maxDisagreement!)} · Kalshi ${k != null ? pct(k) : "—"} vs Polymarket ${pm != null ? pct(pm) : "—"}</div>
        <div style="color:#666;font-size:13px">${escapeHtml(explainer)}</div>
      </li>`;
    })
    .join("");

  const moverItems = movers
    .map(
      (m) => `<li style="margin-bottom:12px">
        <span style="font-weight:600">${escapeHtml(m.market.question)}</span>
        <div style="color:#666;font-size:13px">${escapeHtml(explainMover(m.market.question, m.change))}</div>
      </li>`,
    )
    .join("");

  return `<!doctype html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
    <h1 style="font-size:20px">The week's biggest prediction market gaps</h1>
    <h2 style="font-size:16px;margin-top:24px">Where Kalshi and Polymarket disagree most</h2>
    <ul style="padding-left:18px">${gapItems || "<li>No big gaps this week.</li>"}</ul>
    <h2 style="font-size:16px;margin-top:24px">Biggest moves</h2>
    <ul style="padding-left:18px">${moverItems || "<li>Quiet week.</li>"}</ul>
    <p style="color:#999;font-size:12px;margin-top:32px">
      You're getting this because you subscribed at ${baseUrl}.
      <a href="__UNSUB__" style="color:#999">Unsubscribe</a>
    </p>
  </body>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
