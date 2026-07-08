import type { Task } from "../types/task";

/**
 * Per-user persistence for dismissed confirmation-notice banners, plus the
 * selector that decides which banners are currently visible.
 *
 * Extracted from hooks/useDismissedNotifications.ts and
 * components/home/ConfirmationNotices.tsx so the storage and filtering logic
 * can be unit tested directly (no DOM/React renderer needed), mirroring
 * lib/tasks-live-refresh.ts.
 *
 * Architecture note — localStorage allowance:
 *   The wider app rule is "no localStorage app-state mirror" because Supabase
 *   is the single source of truth for tasks/messages/people. This module is
 *   the one explicit exception: it stores a UI preference (a set of
 *   dismissed banner IDs) so that hard-refreshes and re-logins don't
 *   resurrect notices the user already acknowledged. No task data, no
 *   message data — only a list of ids. Scoped by userId so multi-account
 *   devices don't bleed.
 */

const KEY_PREFIX = "ra7etbal-v2.dismissed-notifications.";
const MAX_NOTICES = 5;

export interface DismissedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function dismissedStorageKey(userId: string): string {
  return KEY_PREFIX + userId;
}

export function readDismissedIds(storage: DismissedStorage, userId: string): Set<string> {
  try {
    const raw = storage.getItem(dismissedStorageKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Writes the dismissed-id set and verifies it actually round-trips before
 * reporting success. The previous implementation trusted `setItem` silently
 * (catch-and-ignore on throw, no verification), so a write that failed or
 * silently no-op'd (private/incognito mode, storage disabled, a corrupted
 * existing value) looked identical to a successful one — the in-memory React
 * state still updated for the rest of that session, and the failure only
 * became visible the next time the id set was read fresh, which is exactly
 * what happens on the auth userId transition triggered by logout → login.
 */
export function writeDismissedIds(
  storage: DismissedStorage,
  userId: string,
  ids: Set<string>,
): boolean {
  const key = dismissedStorageKey(userId);
  const payload = JSON.stringify(Array.from(ids));
  try {
    storage.setItem(key, payload);
  } catch {
    return false;
  }
  try {
    return storage.getItem(key) === payload;
  } catch {
    return false;
  }
}

/**
 * Confirmation banners the owner hasn't dismissed yet — delegations the
 * recipient has confirmed done (status='done' + confirmed_at present).
 * Anything not yet done/confirmed is never eligible, dismissed or not, so
 * this can never hide an active, unresolved item.
 */
export function selectConfirmationNotices(tasks: Task[], dismissed: Set<string>): Task[] {
  return tasks
    .filter(
      (t) =>
        t.type === "delegation" &&
        t.status === "done" &&
        !!t.confirmed_at &&
        !dismissed.has(t.id),
    )
    .sort(
      (a, b) => new Date(b.confirmed_at!).getTime() - new Date(a.confirmed_at!).getTime(),
    )
    .slice(0, MAX_NOTICES);
}
