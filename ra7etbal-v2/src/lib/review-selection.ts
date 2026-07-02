import type { ExtractedItem, ItemType } from "../types/extraction";

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
 * Picks the right empty-state copy. "Nothing extracted" (the user never had
 * anything to review) reads differently from "you removed everything you had"
 * — conflating them would be confusing after a deliberate removal.
 */
export function pickReviewEmptyStateMessage(everHadItems: boolean): string {
  return everHadItems
    ? "You cleared everything. Head to Home to dump more, or ask Carson to turn something into a note, to-do, reminder, or delegation."
    : "Ra7etBal didn't find anything actionable in that. Head back and try rephrasing.";
}

/**
 * Types where attaching a reference/proof photo is a normal, expected part of
 * the flow. Used only to decide whether to show the "Attach photo" AFFORDANCE
 * by default — it never hides or removes a photo the item already has (see
 * shouldShowPhotoControl below), so existing photo attachment behavior for
 * any item that already carries one is fully preserved.
 */
const PHOTO_RELEVANT_TYPES: ReadonlySet<ItemType> = new Set([
  "delegation",
  "message",
  "action",
  "errand",
  "followup",
]);

/**
 * Whether the photo-attachment control should render for this item. Always
 * true if the item already has an attached image (so it stays visible and
 * removable — never hide an existing attachment). Otherwise only true for
 * types where a reference/proof photo is normally relevant, to cut clutter
 * on multi-item reviews where most items are reminders/notes/decisions.
 */
export function shouldShowPhotoControl(item: Pick<ExtractedItem, "type" | "imageFile">): boolean {
  if (item.imageFile) return true;
  return PHOTO_RELEVANT_TYPES.has(item.type);
}
