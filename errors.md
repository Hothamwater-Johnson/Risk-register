# errors.md — mistakes made & lessons

Honest record of agent mistakes in this project, so they aren't repeated.

## 2026-06-11

1. **Guessed a URL instead of checking docs.** Told the user to visit
   `claude.ai/settings/code` — that page doesn't exist. Environment settings
   live in the environment selector dialog at claude.ai/code. The user
   (on a phone, paying for every round-trip) had to push back twice
   ("FABLE. DON'T GUESS.") before the answer came from the actual docs.
   **Lesson: when telling a user where to click or what a product does,
   fetch the documentation first. Never present an inference as a fact.**

2. **Assumed `psql` would reach Neon.** Outbound TCP 5432 is blocked from
   cloud containers; two background psql attempts burned ~2 minutes timing
   out. The Neon HTTP driver (`@neondatabase/serverless` over HTTPS) was
   the working path all along — and the app itself already used it, which
   should have been the hint.
   **Lesson: in a sandboxed/cloud environment, assume only HTTPS egress;
   prefer the same connection path the application code uses.**

3. **Ran `pnpm drizzle-kit migrate` expecting it to read `.env.local`.**
   It doesn't (only Next.js loads that file), and after passing the URL
   inline it hung anyway (neon-http websocket limitation under drizzle-kit).
   Fixed with a one-off script applying each statement individually.
   **Lesson: drizzle-kit needs DATABASE_URL in its own env AND doesn't play
   well with the neon-http driver here; go straight to the script approach.
   (Correction 2026-06-11 session 2: use `sql.query(stmt)` — in
   `@neondatabase/serverless` v1, `sql.unsafe(stmt)` only builds a fragment
   and silently executes NOTHING when awaited directly.)**

4. **Misdiagnosed the network blocking, twice.** First blamed the Bash
   sandbox and restarted the dev server with the sandbox disabled — same
   403. The actual mechanism: the environment's Trusted network allowlist,
   enforced by a transparent proxy; the earlier migration had only worked
   because the approved plan's commands carried one-time network grants.
   Several commands were spent on a theory the first 403 body
   ("Host not in allowlist") had already disproven.
   **Lesson: read the error text literally before forming a theory. An
   allowlist message means policy, not sandboxing.**

5. **Started long-running ingestion work before confirming egress.** The
   dev server was up and sync-catalog called before any reachability check
   of Kalshi/Polymarket/Neon from the server process. A 4-curl preflight
   would have surfaced the policy problem immediately.
   **Lesson: preflight external connectivity before starting servers/jobs
   that depend on it.**

6. **Told the user the network change "may only apply to new sessions"
   as a hedge, then had to verify anyway.** The docs implied it; monitoring
   confirmed it (running sessions never pick up policy changes). The hedge
   cost an extra round-trip with a phone-bound user.
   **Lesson: when a fact is checkable (docs, a 5-minute monitor), check it
   before the user has to act on a "probably."**

## 2026-06-11 (session 2)

7. **"Verified" an auth gate by HTTP status.** Reported /admin/health as
   working because it returned 200 — the page returns 200 to everyone
   and shows a login hint when the token is wrong. The Vercel env-var
   typo was therefore discovered hours later via Unauthorized job calls.
   **Lesson: verify gates by state-specific content (one marker that
   only appears authed, one that only appears denied), never by status.**

8. **Sloppy one-off verification snippets produced two false alarms.**
   `grep -c` counts lines (single-line HTML → max 1) and a re-typed
   regex pipeline missing its pipe-collapse step both reported freshly
   deployed, working features as broken. **Lesson: write the extraction
   snippet once, test it against a known-good page, reuse it verbatim.**

9. **Scattered execution during the deploy firefight** (user: "you are
   all over the place"). Multiple deploy paths in flight at once,
   repeated 200KB run-list fetches, premature "it's live" calls.
   **Lesson: one thread at a time — assess, act once, verify once,
   report. The stop-and-replan request was warranted.**

10. **`pkill -f vercel` matched the invoking shell's own command line**
    and killed the verification chain mid-run (exit 144). **Lesson:
    pkill -f patterns match your own command string; scope to the
    target binary or use the task's PID.**

11. **Assumed Vercel's GitHub webhook worked because "Connect Git
    Repository" showed a checkmark.** The link was `sourceless: true`;
    pushes and deploy-hook jobs died silently for an hour of polling.
    **Lesson: a green checkmark in a UI is a claim, not a verification —
    confirm integrations by their observable effect (a deployment
    object existing), and check the API's view of the resource early.**

## Standing process rules derived from the above

- Verify product/UI claims against documentation before relaying them.
- Preflight connectivity (one curl per dependency) before any job/server.
- Read error bodies literally; diagnose from evidence, not pattern-matching.
- In cloud sessions: HTTPS-only egress, policy fixed at session start,
  background processes can't receive interactive network grants.
