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
   Fixed with a one-off script applying each statement via `sql.unsafe()`.
   **Lesson: drizzle-kit needs DATABASE_URL in its own env AND doesn't play
   well with the neon-http driver here; go straight to the script approach.**

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

## Standing process rules derived from the above

- Verify product/UI claims against documentation before relaying them.
- Preflight connectivity (one curl per dependency) before any job/server.
- Read error bodies literally; diagnose from evidence, not pattern-matching.
- In cloud sessions: HTTPS-only egress, policy fixed at session start,
  background processes can't receive interactive network grants.
