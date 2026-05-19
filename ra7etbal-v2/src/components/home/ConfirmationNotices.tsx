import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAuth } from "../../hooks/useAuth";
import { useDismissedNotifications } from "../../hooks/useDismissedNotifications";
import { useTasksStore } from "../../stores/tasks";

/** Cap surfaced notices so a long-untouched account doesn't flood Home. */
const MAX_NOTICES = 5;

/**
 * Owner-facing confirmation banners.
 *
 * Renders calm green dismissible banners for delegations the recipient has
 * confirmed done (status='done' + confirmed_at present) that the owner
 * hasn't already dismissed. Surfaces only delegations — host-initiated
 * "Mark done myself" actions don't deserve a self-notification.
 *
 * Derived entirely from the existing tasks store; no new fetch, no new
 * schema. Force-refresh of the store on Home mount (wired in Home.tsx)
 * ensures the banner appears when the user returns to the app after a
 * recipient hit /confirm.
 */
export default function ConfirmationNotices() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { dismissed, dismiss } = useDismissedNotifications(userId);

  const tasks = useTasksStore(useShallow((s) => s.items));

  const visible = useMemo(() => {
    return tasks
      .filter(
        (t) =>
          t.type === "delegation" &&
          t.status === "done" &&
          !!t.confirmed_at &&
          !dismissed.has(t.id),
      )
      .sort(
        (a, b) =>
          new Date(b.confirmed_at!).getTime() -
          new Date(a.confirmed_at!).getTime(),
      )
      .slice(0, MAX_NOTICES);
  }, [tasks, dismissed]);

  if (visible.length === 0) return null;

  return (
    <div className="space-y-2" aria-live="polite">
      {visible.map((task) => {
        const who = task.assigned_to ?? "Someone";
        return (
          <div
            key={task.id}
            role="status"
            className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 shadow-sm"
          >
            <span
              aria-hidden
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 12.5l4.5 4.5L19 7.5"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <div className="flex-1 text-sm leading-snug text-emerald-900">
              <span className="font-medium">{who} confirmed:</span>{" "}
              {task.description}
            </div>
            <button
              type="button"
              onClick={() => dismiss(task.id)}
              aria-label="Dismiss notification"
              className="-mr-1 shrink-0 rounded-full p-1 text-emerald-800/60 transition hover:bg-emerald-100 hover:text-emerald-900"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
