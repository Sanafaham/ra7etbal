import { useShallow } from "zustand/react/shallow";
import { useAuthStore, type AuthState, type AuthStatus } from "../stores/auth";

export interface AuthSnapshot {
  status: AuthStatus;
  user: AuthState["user"];
  lastEvent: AuthState["lastEvent"];
  eventCount: AuthState["eventCount"];
}

/**
 * Read the auth machine from a component. Returns a stable snapshot of the
 * public surface only — internal setters are intentionally not exposed.
 * `useShallow` keeps the snapshot identity stable across renders that don't
 * actually change any selected field.
 */
export function useAuth(): AuthSnapshot {
  return useAuthStore(
    useShallow((s) => ({
      status: s.status,
      user: s.user,
      lastEvent: s.lastEvent,
      eventCount: s.eventCount,
    })),
  );
}
