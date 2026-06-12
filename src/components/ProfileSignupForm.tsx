"use client";

import { useActionState } from "react";
import { profileSignup, type SignupState } from "@/app/paper/actions";

const initialState: SignupState = { status: "idle" };

/**
 * Passwordless email + invite-code sign-up/sign-in for testers. On success
 * the server sets the profile cookie and revalidates /paper, so the page
 * re-renders into the signed-in book without navigation.
 */
export function ProfileSignupForm() {
  const [state, formAction, pending] = useActionState(profileSignup, initialState);

  return (
    <form action={formAction} className="space-y-2">
      <input
        type="email"
        name="email"
        required
        placeholder="you@example.com"
        autoComplete="email"
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
      />
      <input
        type="text"
        name="displayName"
        placeholder="Name (optional)"
        autoComplete="name"
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
      />
      <input
        type="text"
        name="inviteCode"
        required
        placeholder="Invite code"
        autoComplete="off"
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
      />
      <button
        disabled={pending}
        className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Start paper trading"}
      </button>
      {state.status === "error" && (
        <p className="text-sm font-medium text-negative">{state.message}</p>
      )}
      <p className="text-xs leading-relaxed text-muted">
        No password — your email is just a label for your book, and the same
        email gets you back in from any device. You start with a fresh virtual
        $1,000.
      </p>
    </form>
  );
}
