"use client";

import { useState } from "react";

export function EmailSignup({ source = "web" }: { source?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [email, setEmail] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, source }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p className="rounded-xl bg-positive/10 p-4 text-sm font-medium text-positive">
        You&apos;re in — the weekly gap digest lands Monday mornings.
      </p>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-border bg-card p-4"
    >
      <p className="text-sm font-semibold">The weekly gap digest, free</p>
      <p className="mt-1 text-xs text-muted">
        Every Monday: the 5 biggest Kalshi-vs-Polymarket gaps and the week&apos;s
        wildest moves, explained in plain English.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={state === "busy"}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {state === "busy" ? "…" : "Subscribe"}
        </button>
      </div>
      {state === "error" && (
        <p className="mt-2 text-xs text-negative">
          That didn&apos;t work — check the address and try again.
        </p>
      )}
    </form>
  );
}
