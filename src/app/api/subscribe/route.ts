import { z } from "zod";
import { db } from "@/lib/db/client";
import { emailSubscribers } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.email().max(254),
  source: z.string().max(100).optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    parsed = { success: false as const, error: null };
  }
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid email" }, { status: 400 });
  }

  await db()
    .insert(emailSubscribers)
    .values({
      email: parsed.data.email.toLowerCase().trim(),
      source: parsed.data.source ?? "web",
    })
    .onConflictDoNothing();

  // Same response whether new or existing — no email enumeration.
  return Response.json({ ok: true });
}
