import type { Task } from "../types/task";

/**
 * Selector that decides which confirmation-notice banners are currently
 * visible to the owner.
 *
 * Dismissal state is server-backed (tasks.dismissed_at) — it survives
 * refresh, logout/login, and stays identical across Safari, an installed
 * PWA, and other devices, since it hydrates from the same tasks row every
 * client already loads via useTasksStore. This module previously also
 * managed a localStorage-based dismissal set as a "one explicit exception"
 * to the app's Supabase-is-the-source-of-truth rule; that was the root
 * cause of dismissed notices resurfacing after a Safari logout/login or on
 * an installed PWA with different local storage. Removed — no client-side
 * dismissal state remains.
 */

const MAX_NOTICES = 5;

/**
 * Confirmation banners the owner hasn't dismissed yet — delegations the
 * recipient has confirmed done (status='done' + confirmed_at present) that
 * are not yet dismissed_at. Anything not yet done/confirmed is never
 * eligible, dismissed or not, so this can never hide an active, unresolved
 * item.
 */
export function selectConfirmationNotices(tasks: Task[]): Task[] {
  return tasks
    .filter(
      (t) =>
        t.type === "delegation" &&
        t.status === "done" &&
        !!t.confirmed_at &&
        !t.dismissed_at,
    )
    .sort(
      (a, b) => new Date(b.confirmed_at!).getTime() - new Date(a.confirmed_at!).getTime(),
    )
    .slice(0, MAX_NOTICES);
}
