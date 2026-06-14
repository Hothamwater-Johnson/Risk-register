# Security flaws — known issues log

A running, honest list of the security weaknesses in Spread Scout. This is a
**tracking doc**, not a promise that any of these are fixed. We log them here and
clean them up over time; new flaws should be appended as they're found.

## Context / threat model (read this first)

What this app actually holds matters for prioritization:

- **No real money, no custody.** Trading is *paper* only — virtual fills against
  our own snapshots. There are no real orders, balances, withdrawals, or keys.
- **Mostly public data.** Events, markets, and prices come from public Kalshi /
  Polymarket APIs. Leaking them leaks nothing private.
- **A little PII.** Tester `profiles` store unverified emails + display names.
- **One trust boundary that matters:** the `ADMIN_TOKEN` and `CRON_SECRET`. A
  leak of either lets someone act as the owner / trigger jobs.

So: "security disaster" is fair as *posture*, but the blast radius today is
limited (paper P&L + a handful of emails). The priority is to stop the bad
habits from hardening into the codebase before anything real (auth, money, user
data) is built on top of them. **Do not build anything sensitive on this until
the HIGH items are addressed.**

## What's actually OK (so we don't "fix" it twice)

- Profile session cookies are HMAC-SHA256 signed and verified with
  `timingSafeEqual` (`src/lib/profile.ts` `sealProfileId`/`unsealProfileId`) —
  not forgeable without the server secret.
- Job routes (`/api/jobs/*`) require a `Bearer $CRON_SECRET` (`requireCronAuth`).
- DB access goes through Drizzle with parameterized queries — no raw SQL string
  interpolation found (so no classic SQLi).
- Auth cookies are `httpOnly` + `sameSite=lax` + `secure` in prod.

---

## Flaws

Severity is relative to *this* app's threat model above, not absolute.

### HIGH

- **H1 — `ADMIN_TOKEN` is overloaded into three roles.** It is (a) the owner
  auth secret (`isAdmin`, `src/lib/config.ts`), (b) stored *raw* as the value of
  the `paper_token` cookie (`paperLogin`, `src/app/paper/actions.ts`), and (c)
  the HMAC signing key for profile cookies (`signingKey`, `src/lib/profile.ts`).
  One secret, three jobs → any single leak is total, and rotating it silently
  invalidates every tester session. *Fix:* separate secrets — a dedicated
  cookie-signing key, and store a derived/opaque session value in the cookie
  rather than the token itself.

- **H2 — Admin auth passed via `?token=ADMIN_TOKEN` URL query param.** Used by
  every `/admin/*` page (`searchParams.token`). Query strings leak into browser
  history, server/proxy/CDN access logs, and `Referer` headers on outbound
  links. *Fix:* accept the token only via the (httpOnly cookie) login flow or a
  header; never the URL. The new `/admin/auto-trader` cookie login is the right
  pattern to generalize.

- **H3 — Non-constant-time secret comparison.** `isAdmin` (`token === expected`),
  `inviteCodeOk` (`code === expected`), and the auto-trader password check all
  use `===`, which short-circuits and is timing-observable. (Profile HMAC
  already does it right with `timingSafeEqual` — inconsistent.) *Fix:* route all
  secret comparisons through a constant-time helper.

- **H4 — Auto-trader page password now guards state-changing + destructive
  actions.** Default `"hotham"` lives in source (`AUTO_TRADER_PASSWORD`,
  `src/lib/config.ts`), the page is linked from the public nav, the password is
  stored *raw* in the `at_access` cookie, it's shared (not per-user), and never
  rotates. The page is **no longer read-only**: behind this same gate sit
  start/stop, a **destructive "clear session"** (wipes the bot book), and a CSV
  export of results (`src/app/admin/auto-trader/*`, `src/lib/autoTrader.ts`).
  Each server action re-checks `hasAutoTraderAccess`, so the gate is enforced —
  but it's still only the weak shared password. Blast radius is paper-only (an
  attacker could pause/clear the bot or read its paper P&L; no money, no real
  data). *Fix:* set `AUTO_TRADER_PASSWORD` to a non-default value in prod now;
  longer term fold this page into proper admin auth (see H1/H2), and consider
  gating the destructive `clear` behind the stronger `ADMIN_TOKEN` path only.

### MEDIUM

- **M1 — No rate limiting / lockout on any auth entry point.** `paperLogin`
  (admin-token guessing), `profileSignup` (invite-code brute force), and the
  auto-trader `unlock` action have no throttling, lockout, or CAPTCHA. Combined
  with single shared static secrets, they're brute-forceable. *Fix:* add
  per-IP/identity rate limiting + backoff on these actions.

- **M2 — No email verification for tester profiles.** Typing any email claims
  that identity (documented, deliberate; `src/lib/profile.ts`). Anyone holding
  the invite code can impersonate any email / display name. Acceptable for "a
  few friends," unacceptable the moment profiles gate anything. *Fix:* email
  verification (magic link) before a profile is usable.

- **M3 — `INVITE_CODE` is a single shared static secret.** No per-invite
  issuance, expiry, usage cap, or revocation (`src/lib/profile.ts`). One leak
  opens signups to everyone with no way to cut it off short of rotating for all.
  *Fix:* per-invite tokens with expiry + revocation.

- **M4 — Server-action CSRF posture unverified.** State-changing flows are React
  Server Actions; we rely on Next's built-in same-origin/Origin checks and have
  added nothing on top. *Fix:* confirm the framework's CSRF protections are
  active for our Next version and document the assumption; add explicit checks if
  not.

### LOW / hardening

- **L1 — LIKE-wildcard injection in search.** `searchMarkets` builds
  `ilike('%' + q + '%')` (`src/lib/queries.ts`). Drizzle parameterizes the value
  (no SQLi), but user-supplied `%` / `_` act as wildcards → unexpected matches /
  expensive scans. *Fix:* escape LIKE metacharacters in `q`.

- **L2 — No Content-Security-Policy / security headers.** No CSP, HSTS, or
  `X-Frame-Options` configured (`next.config.ts`). An XSS would be unconstrained.
  *Fix:* add a baseline CSP + security headers.

- **L3 — `NEXT_PUBLIC_*` audit (currently clean).** Grep found one such var,
  `NEXT_PUBLIC_BASE_URL` (`src/app/api/jobs/digest/route.ts`), which is a public
  base URL — not a secret. No action needed now; *fix:* add a lint rule so a
  future secret can't slip into a `NEXT_PUBLIC_` var unnoticed.

- **L4 — No audit logging of privileged actions.** Admin match
  confirms/rejects, manual settlements, and trade deletions aren't logged with
  actor + timestamp. *Fix:* minimal append-only audit trail.

---

## Cleanup order (when we get to it)

1. **H2 + H1** — get the admin token out of URLs and stop storing/reusing it raw;
   introduce a dedicated session/signing secret. (Biggest structural win.)
2. **H3** — constant-time comparisons (tiny, do it alongside H1).
3. **H4** — set a real `AUTO_TRADER_PASSWORD` in prod immediately; fold the page
   into admin auth later.
4. **M1 / M2 / M3** — before profiles or signups gate anything beyond paper.
5. **M4, L1–L4** — hardening pass.

## How to use this doc

- Append new findings under the right severity with: where it lives (file), why
  it matters *here*, and a one-line fix.
- When something is fixed, move it to a "Resolved" section with the commit/PR,
  don't delete it — the history is useful.
