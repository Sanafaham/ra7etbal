import type { ItemType } from "../types/extraction";

/**
 * Pure selection/decision logic for the Clear My Head Review screen.
 *
 * Clear My Head is a temporary thought dump and review space only — it never
 * persists items to Notes/To-dos/Reminders/Delegations/Messages. Items here
 * are either kept (stays in the in-memory extraction store) or discarded.
 * Carson (voice + text-carson.ts / ops-intelligence.ts) remains the only path
 * that converts thoughts into saved records.
 */

/**
 * Display label for an item's badge on the Clear My Head Review screen only.
 *
 * Nothing here is ever saved, so the badge must not read like a real
 * Carson-created object (e.g. bare "To-do" or "Reminder") — that implies
 * persistence that hasn't happened. `item.type` itself is untouched and
 * keeps driving real behavior (assignment visibility, message relevance,
 * photo control); this only changes what text renders in the badge.
 */
export function reviewDisplayLabel(type: ItemType): string {
  return type === "parked" ? "Thought" : "Detected";
}

/**
 * Picks the right empty-state copy. "Nothing extracted" (the user never had
 * anything to review) reads differently from "you removed everything you had"
 * — conflating them would be confusing after a deliberate removal.
 */
export function pickReviewEmptyStateMessage(everHadItems: boolean): string {
  return everHadItems
    ? "You cleared everything. Head to Home to dump more, or ask Carson to turn something into a note, to-do, reminder, or delegation."
    : "Ra7etBal didn't find anything actionable in that. Head back and try rephrasing.";
}
