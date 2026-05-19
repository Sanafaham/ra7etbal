import { useCallback, useEffect, useState } from "react";

/**
 * Per-user list of confirmation-notice IDs the owner has already dismissed.
 *
 * Architecture note — localStorage allowance:
 *   The wider app rule is "no localStorage app-state mirror" because Supabase
 *   is the single source of truth for tasks/messages/people. This hook is the
 *   one explicit exception: it stores a UI preference (a set of dismissed
 *   banner IDs) so that hard-refreshes don't resurrect notices the user has
 *   already acknowledged. No task data, no message data — only a list of ids.
 *   Scoped by userId so multi-account devices don't bleed.
 */

const KEY_PREFIX = "ra7etbal-v2.dismissed-notifications.";

function storageKey(userId: string): string {
  return KEY_PREFIX + userId;
}

function readDismissed(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function writeDismissed(userId: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(
      storageKey(userId),
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    /* quota exceeded, private mode, etc — silently ignore */
  }
}

export interface DismissedAPI {
  dismissed: Set<string>;
  dismiss: (id: string) => void;
}

export function useDismissedNotifications(userId: string | null): DismissedAPI {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!userId) {
      setDismissed(new Set());
      return;
    }
    setDismissed(readDismissed(userId));
  }, [userId]);

  const dismiss = useCallback(
    (id: string) => {
      if (!userId) return;
      setDismissed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        writeDismissed(userId, next);
        return next;
      });
    },
    [userId],
  );

  return { dismissed, dismiss };
}
