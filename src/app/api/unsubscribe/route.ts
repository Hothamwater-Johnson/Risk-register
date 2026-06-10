import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { emailSubscribers } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token || !z.uuid().safeParse(token).success) {
    return new Response("Invalid unsubscribe link", { status: 400 });
  }

  await db()
    .update(emailSubscribers)
    .set({ unsubscribedAt: new Date() })
    .where(
      and(
        eq(emailSubscribers.unsubscribeToken, token),
        isNull(emailSubscribers.unsubscribedAt),
      ),
    );

  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center"><h2>You're unsubscribed</h2><p>You won't get the weekly digest anymore. Changed your mind? Re-subscribe any time on the site.</p></body>`,
    { headers: { "content-type": "text/html" } },
  );
}
