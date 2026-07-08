import { useCallback, useEffect, useState } from "react";
import { readDismissedIds, writeDismissedIds } from "../lib/dismissed-notifications";

/**
 * Per-user list of confirmation-notice IDs the owner has already dismissed.
 * Storage/verification logic lives in lib/dismissed-notifications.ts so it
 * can be unit tested without a DOM/React renderer — this hook is a thin
 * wrapper wiring that module to component state.
 */

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
    setDismissed(readDismissedIds(window.localStorage, userId));
  }, [userId]);

  const dismiss = useCallback(
    (id: string) => {
      if (!userId) return;
      setDismissed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        writeDismissedIds(window.localStorage, userId, next);
        return next;
      });
    },
    [userId],
  );

  return { dismissed, dismiss };
}
