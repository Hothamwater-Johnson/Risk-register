import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { profiles, type Profile } from "./db/schema";

/**
 * Tester identity: passwordless email sign-up gated by a shared INVITE_CODE
 * env var. The session cookie is `profileId.hmac(profileId)` signed with
 * ADMIN_TOKEN, so a cookie can't be forged without the server secret — but
 * there is NO email verification: typing someone's email claims it. That's
 * the deliberate trade-off for "a few friends try it out" with zero email
 * infrastructure. Don't build anything sensitive on top of this.
 */

export const PROFILE_COOKIE = "ss_profile";
export const PAPER_COOKIE = "paper_token";

function signingKey(): string | null {
  return process.env.ADMIN_TOKEN ?? null;
}

function sign(profileId: string, key: string): string {
  return createHmac("sha256", key).update(profileId).digest("hex");
}

export function inviteCodeOk(code: string | null | undefined): boolean {
  const expected = process.env.INVITE_CODE;
  return Boolean(expected && code && code.trim() === expected);
}

export function sealProfileId(profileId: string): string | null {
  const key = signingKey();
  if (!key) return null;
  return `${profileId}.${sign(profileId, key)}`;
}

export function unsealProfileId(cookieValue: string | null | undefined): string | null {
  const key = signingKey();
  if (!key || !cookieValue) return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;
  const id = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const expected = sign(id, key);
  if (mac.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))) {
      return null;
    }
  } catch {
    return null;
  }
  return id;
}

export type PaperIdentity =
  | { kind: "admin"; profile: null }
  | { kind: "profile"; profile: Profile };

/** Who is paper trading right now? Admin token outranks a profile cookie. */
export async function getPaperIdentity(): Promise<PaperIdentity | null> {
  const store = await cookies();
  const adminToken = store.get(PAPER_COOKIE)?.value;
  const expected = process.env.ADMIN_TOKEN;
  if (expected && adminToken === expected) return { kind: "admin", profile: null };

  const profileId = unsealProfileId(store.get(PROFILE_COOKIE)?.value);
  if (!profileId) return null;
  const [profile] = await db()
    .select()
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .limit(1);
  return profile ? { kind: "profile", profile } : null;
}

/** The paper_trades.profile_id value this identity owns (null = owner's book). */
export function identityProfileId(id: PaperIdentity): string | null {
  return id.kind === "admin" ? null : id.profile.id;
}
