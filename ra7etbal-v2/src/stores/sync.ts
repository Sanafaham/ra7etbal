import { useAuthStore } from "./auth";
import { useMessagesStore } from "./messages";
import { usePeopleStore } from "./people";
import { useProfileStore } from "./profile";
import { useTasksStore } from "./tasks";

/**
 * Cross-store coupling: when auth flips to signed_out (or recovery), clear
 * the people cache so the next signed-in user can't briefly see the previous
 * user's data. The reverse direction — loading when a user signs in — is
 * driven by the People route's `useEffect` so we don't fetch lists the user
 * isn't looking at yet.
 *
 * Subscribed once at module import. HMR-safe: a global guard prevents a
 * second subscription on hot reload.
 */
declare global {
  // eslint-disable-next-line no-var
  var __ra7etbal_store_sync: (() => void) | undefined;
}

if (globalThis.__ra7etbal_store_sync) {
  globalThis.__ra7etbal_store_sync();
}

const unsub = useAuthStore.subscribe((s, prev) => {
  if (prev.status !== s.status && (s.status === "signed_out" || s.status === "recovery")) {
    usePeopleStore.getState().reset();
    useProfileStore.getState().reset();
    useTasksStore.getState().reset();
    useMessagesStore.getState().reset();
  }
});

globalThis.__ra7etbal_store_sync = unsub;
