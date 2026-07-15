import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { useAuth } from "../../hooks/useAuth";
import { selectConfirmationNotices } from "../../lib/dismissed-notifications";
import { useTasksStore } from "../../stores/tasks";

const MAX_SUMMARY_LENGTH = 110;

function confirmationSummary(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SUMMARY_LENGTH) return normalized;

  const clipped = normalized.slice(0, MAX_SUMMARY_LENGTH + 1);
  const lastWordBreak = clipped.lastIndexOf(" ");
  const summary =
    lastWordBreak > MAX_SUMMARY_LENGTH * 0.7
      ? clipped.slice(0, lastWordBreak)
      : normalized.slice(0, MAX_SUMMARY_LENGTH);

  return `${summary.trimEnd()}…`;
}

/**
 * Owner-facing confirmation banners.
 *
 * Renders calm green dismissible banners for delegations the recipient has
 * confirmed done (status='done' + confirmed_at present) that the owner
 * hasn't already dismissed. Surfaces only delegations — host-initiated
 * "Mark done myself" actions don't deserve a self-notification.
 *
 * Derived entirely from the existing tasks store (dismissal state lives on
 * tasks.dismissed_at); no new fetch, no client-side dismissal state. Force-
 * refresh of the store on Home mount (wired in Home.tsx) ensures the banner
 * appears when the user returns to the app after a recipient hit /confirm.
 */
export default function ConfirmationNotices() {
  const { status } = useAuth();
  const location = useLocation();

  const tasks = useTasksStore(useShallow((s) => s.items));
  const dismiss = useTasksStore((s) => s.dismissConfirmationNotice);

  const visible = useMemo(
    () => selectConfirmationNotices(tasks),
    [tasks],
  );

  // Hide on the public recipient page and whenever the owner isn't signed in.
  // This component renders at the app-shell level now, so it must self-gate.
  const isPublicConfirmPage = location.pathname === "/confirm";
  if (status !== "signed_in" || isPublicConfirmPage) return null;

  if (visible.length === 0) return null;

  return (
    <div data-testid="confirmation-notices" className="mb-4 space-y-2.5" aria-live="polite">
      {visible.map((task) => {
        const who = task.assigned_to ?? "Someone";
        const summary = confirmationSummary(task.description);
        return (
          <div
            key={task.id}
            data-testid={`confirmation-notice-${task.id}`}
            role="status"
            className="flex items-start gap-3 rounded-2xl border border-gold/30 bg-gold/[0.08] px-4 py-3.5 shadow-[0_8px_24px_-18px_rgba(184,155,94,0.35)]"
          >
            <span
              aria-hidden
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gold text-white"
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
            <div className="min-w-0 flex-1 text-sm leading-snug text-text">
              <p className="line-clamp-2">
                <span className="font-semibold text-ink">{who} confirmed:</span>{" "}
                {summary}
              </p>
              {task.proof_image_path && (
                <span data-testid={`confirmation-notice-proof-${task.id}`} className="mt-1 flex items-center gap-1 text-[11px] font-medium text-gold-dark">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle
                      cx="12"
                      cy="13"
                      r="4"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                  Proof photo attached — view in Done
                </span>
              )}
            </div>
            <button
              data-testid={`confirmation-notice-dismiss-${task.id}`}
              type="button"
              onClick={() => dismiss(task.id)}
              aria-label="Dismiss notification"
              className="-mr-1 shrink-0 rounded-full p-1 text-ink/45 transition hover:bg-gold/10 hover:text-ink/80"
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
