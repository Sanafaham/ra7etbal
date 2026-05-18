import { create } from "zustand";
import type { User } from "@supabase/supabase-js";

/**
 * Auth state machine
 *
 *   loading      → boot state, waiting for the first auth event
 *   signed_out   → no session
 *   signed_in    → normal authenticated session
 *   recovery     → user opened a password-reset link; only the Reset screen is allowed
 *                  until updateUser() succeeds and clearRecovery() is called
 *
 * Only `lib/session.ts` should call the setter actions. Components read via the
 * `useAuth` hook in `hooks/useAuth.ts`.
 */
export type AuthStatus = "loading" | "signed_out" | "signed_in" | "recovery";

export interface AuthState {
  status: AuthStatus;
  user: User | null;
  /** Last event the listener observed — useful for the debug page. */
  lastEvent: string | null;
  /** Monotonic counter — surfaces accidental duplicate listeners. */
  eventCount: number;

  // Internal setters — only the session machine calls these.
  _setSignedIn: (user: User) => void;
  _setSignedOut: () => void;
  _setRecovery: (user: User) => void;
  _refreshUser: (user: User) => void;
  _noteEvent: (event: string) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "loading",
  user: null,
  lastEvent: null,
  eventCount: 0,

  _setSignedIn: (user) =>
    set((s) =>
      // If we're in recovery, do NOT auto-promote to signed_in. The recovery
      // session emits a SIGNED_IN event by design; honoring it would skip the
      // Reset screen.
      s.status === "recovery" ? s : { status: "signed_in", user },
    ),

  _setSignedOut: () => set({ status: "signed_out", user: null }),

  _setRecovery: (user) => set({ status: "recovery", user }),

  _refreshUser: (user) =>
    set((s) => (s.status === "signed_in" || s.status === "recovery" ? { user } : s)),

  _noteEvent: (event) =>
    set((s) => ({ lastEvent: event, eventCount: s.eventCount + 1 })),
}));

/**
 * Called by the Reset screen after `auth.updateUser({ password })` succeeds.
 * Clears the recovery lock so the next sign-in proceeds normally.
 */
export function clearRecovery(): void {
  useAuthStore.setState({ status: "signed_out", user: null });
}
