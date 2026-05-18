import type { AuthChangeEvent, Session, Subscription } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { clearRecovery, useAuthStore } from "../stores/auth";

/**
 * Session state machine — single source of truth for the user's auth status.
 *
 * Design rules (the reason this file exists):
 *
 *   1. The `onAuthStateChange` listener is registered SYNCHRONOUSLY at module
 *      import time. There is no awaitable boundary between client creation and
 *      listener registration — that way Supabase's URL-hash processing cannot
 *      emit `PASSWORD_RECOVERY` before we are listening for it.
 *
 *   2. We do NOT call `getSession()`. Supabase v2 emits an `INITIAL_SESSION`
 *      event with the current session (possibly null) right after the client
 *      hydrates. Using only the event stream removes every race between the
 *      promise and the event listener.
 *
 *   3. The state machine is HMR-safe: a global guard prevents a second
 *      subscription from being installed when Vite re-evaluates the module.
 *      Restart the dev server if behavior diverges — but a normal hot reload
 *      will not duplicate listeners.
 *
 *   4. The recovery state is sticky. We enter it on `PASSWORD_RECOVERY` and
 *      we ignore the subsequent `SIGNED_IN` event that Supabase fires for the
 *      recovery session itself. Only `clearRecovery()` (called by the Reset
 *      screen after `updateUser` succeeds) leaves the recovery state.
 */

declare global {
  // eslint-disable-next-line no-var
  var __ra7etbal_session_sub: Subscription | undefined;
}

const store = useAuthStore.getState();

function handleEvent(event: AuthChangeEvent, session: Session | null): void {
  useAuthStore.getState()._noteEvent(event);

  switch (event) {
    case "INITIAL_SESSION":
      if (!session) {
        store._setSignedOut();
        return;
      }
      // If the URL still carries a recovery hash, the very next event will be
      // PASSWORD_RECOVERY — let that handler set the state. Otherwise this is
      // a normal restored session.
      if (window.location.hash.includes("type=recovery")) {
        store._setRecovery(session.user);
      } else {
        store._setSignedIn(session.user);
      }
      return;

    case "PASSWORD_RECOVERY":
      if (session) store._setRecovery(session.user);
      return;

    case "SIGNED_IN":
      if (session) store._setSignedIn(session.user);
      return;

    case "SIGNED_OUT":
      store._setSignedOut();
      return;

    case "TOKEN_REFRESHED":
    case "USER_UPDATED":
      if (session) store._refreshUser(session.user);
      return;

    default:
      // MFA_CHALLENGE_VERIFIED and any future events: no-op for now.
      return;
  }
}

// Install (or re-install across HMR) exactly one listener.
if (globalThis.__ra7etbal_session_sub) {
  globalThis.__ra7etbal_session_sub.unsubscribe();
}
const { data } = supabase.auth.onAuthStateChange(handleEvent);
globalThis.__ra7etbal_session_sub = data.subscription;

// Re-export the public Reset-flow helper so other modules import it from one place.
export { clearRecovery };

/** Explicit sign-out. Returns when Supabase has flipped state. */
export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
