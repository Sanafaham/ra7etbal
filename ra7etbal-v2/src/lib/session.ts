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
        console.debug("[auth] INITIAL_SESSION → signed_out (no session)");
        return;
      }
      // Two recovery indicators to check:
      //   1. Implicit flow: URL hash contains `type=recovery` (legacy, non-PKCE)
      //   2. PKCE flow: SDK exchanges the ?code= and removes it from the URL via
      //      history.replaceState *before* INITIAL_SESSION fires, so we can no
      //      longer see ?code= here. But we know we're on /reset because that's
      //      the redirectTo we sent to Supabase, and the only way INITIAL_SESSION
      //      fires with a live session on /reset is via the PKCE recovery exchange.
      //      The real PASSWORD_RECOVERY event arrives in the next setTimeout tick;
      //      pre-setting recovery here prevents ResetRoute from navigating away
      //      with a premature signed_in → Navigate("/") before that tick fires.
      {
        const isImplicitRecovery = window.location.hash.includes("type=recovery");
        const isPkceRecovery = window.location.pathname === "/reset";
        console.debug("[auth] INITIAL_SESSION → session present", {
          isImplicitRecovery,
          isPkceRecovery,
          path: window.location.pathname,
          hash: window.location.hash,
          search: window.location.search,
        });
        if (isImplicitRecovery || isPkceRecovery) {
          store._setRecovery(session.user);
        } else {
          store._setSignedIn(session.user);
        }
      }
      return;

    case "PASSWORD_RECOVERY":
      console.debug("[auth] PASSWORD_RECOVERY fired", { hasSession: !!session });
      if (session) store._setRecovery(session.user);
      return;

    case "SIGNED_IN":
      console.debug("[auth] SIGNED_IN fired", {
        hasSession: !!session,
        path: window.location.pathname,
        currentStatus: useAuthStore.getState().status,
      });
      if (!session) return;
      // On /reset, verifyOtp fires SIGNED_IN immediately before PASSWORD_RECOVERY.
      // Pre-set recovery here to avoid a flash-navigate to "/" before the
      // PASSWORD_RECOVERY event arrives in the next tick.
      if (window.location.pathname === "/reset") {
        store._setRecovery(session.user);
      } else {
        store._setSignedIn(session.user);
      }
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
