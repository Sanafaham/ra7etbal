import type { ExtractedItem, ItemType } from "../types/extraction";

/**
 * Pure selection/decision logic for the Clear My Head Review screen.
 *
 * Extracted from Review.tsx so it's independently unit-testable without a
 * component-rendering harness. Review.tsx always derives its Save & Send
 * behavior from the current `items` array in the extraction store — a
 * removed item is filtered out of that array (see stores/extraction.ts
 * removeItem), so every function here automatically "sees" removals: there
 * is no separate removal-awareness needed, only "operate on whatever items
 * are currently present."
 */

export interface ReviewSendableCheck {
  type: string | null;
  kind: string | null;
  category: string | null;
  assignedPerson: string | null;
  messageTextPresent: boolean;
  isPersonalReminder: boolean;
  isSendable: boolean;
}

export function getReviewSendableCheck(item: unknown): ReviewSendableCheck {
  const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const type = readString(record.type);
  const kind = readString(record.kind);
  const category = readString(record.category);
  const assignedPerson =
    readString(record.assignedTo) ??
    readString(record.assigned_to) ??
    readString(record.assignee) ??
    readString(record.recipient) ??
    readString(record.recipientName);
  const messageText =
    readString(record.suggestedMessage) ??
    readString(record.message) ??
    readString(record.content) ??
    readString(record.body) ??
    readString(record.text);
  const normalizedType = (type ?? kind ?? category ?? "").toLowerCase();
  const normalizedAssignee = assignedPerson?.toLowerCase() ?? "";
  const hasRealAssignedPerson =
    !!assignedPerson &&
    normalizedAssignee !== "__me__" &&
    normalizedAssignee !== "me" &&
    normalizedAssignee !== "owner";
  const messageTextPresent = !!messageText;
  const isPersonalReminder =
    normalizedType === "reminder" &&
    (!hasRealAssignedPerson || normalizedAssignee === "__me__");

  return {
    type,
    kind,
    category,
    assignedPerson,
    messageTextPresent,
    isPersonalReminder,
    isSendable: hasRealAssignedPerson && messageTextPresent && !isPersonalReminder,
  };
}

/** True when at least one currently-present item would actually be sent. */
export function hasSendableMessages(items: unknown[]): boolean {
  return items.some((item) => getReviewSendableCheck(item).isSendable);
}

/**
 * Whether Save & Send should be enabled/shown at all. False when the review
 * list is empty — whether because extraction found nothing, or because the
 * user removed every item. Requirement: "If all items are removed... disable
 * Save & Send."
 */
export function canSaveAndSend(items: unknown[]): boolean {
  return items.length > 0;
}

/**
 * Picks the right empty-state copy. "Nothing extracted" (the user never had
 * anything to review) reads differently from "you removed everything you had"
 * — conflating them would be confusing after a deliberate removal.
 */
export function pickReviewEmptyStateMessage(everHadItems: boolean): string {
  return everHadItems
    ? "You removed everything. Nothing will be saved — add something back or head to Home to start over."
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

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
