import type { OpenStaffEscalation } from "../types/staff-message";

/**
 * Phase C — returns every open staff escalation unchanged. Performs no
 * deduplication.
 *
 * Confirmed production-review defect (independent re-review of PR #90):
 * this used to drop an escalation whenever its task_id matched a task
 * already shown in Needs You, on the assumption that a shared task_id
 * meant "the same owner decision." That assumption is false — a task can
 * independently appear in Needs You for a reason wholly unrelated to
 * Phase B (a pending quality-review intervention, a cancellation, a
 * self-owned decision task), while a staff escalation on that same task
 * represents a genuinely separate owner decision. Hiding it there made it
 * invisible everywhere, since the Staff tab is deliberately not restored
 * by this feature — directly undermining the one thing Phase C exists to
 * fix.
 *
 * There is no reliable shared-decision identifier in the current schema —
 * task_id alone is not one, and no heuristic (text, category, timing) is
 * an acceptable substitute for a real one. Visibility matters more than
 * cosmetic duplicate suppression, so no filtering happens here at all.
 *
 * The `shownTaskIds` parameter is kept, unused, so every existing call
 * site (Home.tsx, Updates.tsx, BottomNav.tsx) needs no change, and so a
 * future genuinely reliable dedup signal — e.g. Phase B recording which
 * specific staff_messages/task pairing an escalation supersedes — could
 * be reintroduced here without touching any call site again.
 */
export function filterVisibleStaffEscalations(
  escalations: OpenStaffEscalation[],
  _shownTaskIds: Iterable<string>,
): OpenStaffEscalation[] {
  return escalations;
}
