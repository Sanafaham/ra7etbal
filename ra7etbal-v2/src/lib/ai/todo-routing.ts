import type { ExtractedItem } from "../../types/extraction";

/**
 * Deterministic post-processing pass over Clear My Head's extraction
 * result. The Sonnet extraction prompt has no concept of "to-do" — a bare
 * personal action item with no due date and no delegate comes back typed
 * "action" or "errand" (its closest existing buckets), which previously
 * meant it was saved as a row in `tasks` and surfaced under Needs You.
 *
 * Rule: reclassify "action"/"errand" items to "todo" UNLESS the model
 * already attached a due date (→ stays a dated task/reminder-shaped item)
 * or a delegate other than the signed-in user (→ stays a delegation-shaped
 * item). Both of those signals mean the prompt's own classification already
 * correctly identified a reminder/delegation/calendar-relevant item, so
 * this never needs to inspect the raw source text itself.
 *
 * savePending() (save.ts) routes "todo"-typed items into carson_todos
 * instead of creating a `tasks` row.
 */
export function applyTodoRouting(items: ExtractedItem[]): ExtractedItem[] {
  return items.map((item) => {
    if (item.type !== "action" && item.type !== "errand") return item;
    if (item.dueAt) return item;
    if (item.assignedTo && item.assignedTo !== "__me__") return item;
    return { ...item, type: "todo" };
  });
}
