import type { OpenStaffEscalation } from "../types/staff-message";

/**
 * Phase C — excludes a staff escalation whose linked task is already being
 * shown as its own Needs You card, so the owner never sees the same
 * decision twice. Pure and shared by Home, Updates, and BottomNav so their
 * counts/lists can never drift from each other.
 */
export function filterVisibleStaffEscalations(
  escalations: OpenStaffEscalation[],
  shownTaskIds: Iterable<string>,
): OpenStaffEscalation[] {
  const shown = new Set(shownTaskIds);
  return escalations.filter((e) => !e.taskId || !shown.has(e.taskId));
}
