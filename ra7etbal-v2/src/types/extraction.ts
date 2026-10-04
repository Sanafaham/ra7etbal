import type { DeclaredOwnerPerspective } from "../../shared/owner-perspective.js";
/**
 * AI extraction types — mirror the JSON shape the model returns.
 *
 * Eight item types come from the v1 prompt (which we reuse verbatim):
 *   action      — needs doing, clear next step
 *   reminder    — time-based or to-be-remembered
 *   message     — one-way communication; no follow-up required
 *   delegation  — assign someone to DO and confirm
 *   decision    — unresolved choice
 *   followup    — waiting on someone or something
 *   errand      — shopping, pickup, errand
 *   parked      — idea for later
 *
 * "todo" is NOT part of the model's vocabulary — the extraction prompt never
 * returns it. It's applied deterministically by applyTodoRouting() in
 * todo-routing.ts as a post-processing pass over "action"/"errand" items
 * with no due date and no delegate, so it never needs prompt changes.
 * savePending() routes "todo" items into carson_todos instead of tasks.
 */
export type ItemType =
  | "action"
  | "reminder"
  | "message"
  | "delegation"
  | "decision"
  | "followup"
  | "errand"
  | "parked"
  | "todo";

/** "__me__" is the sentinel for the signed-in user; otherwise it's a person name. */
export type Assignment = "__me__" | string | null;

export interface ExtractedItem {
  id: string;
  type: ItemType;
  description: string;
  assignedTo: Assignment;
  dueAt: string | null;
  dueText: string | null;
  suggestedMessage: string | null;
  /**
   * Optional personal or informational note to be included in the WhatsApp
   * message body but NOT tracked as a separate task.
   *
   * Set by the extraction prompt when the user appended an emotional note or
   * status clause to an actionable delegation:
   *   "Ask Grace to call me and tell her I miss her."
   *   → personalNote: "Sana says she misses you."
   *   "Ask Grace to wait for me, I am on my way."
   *   → personalNote: "Sana is on her way."
   *
   * Injected into the final WhatsApp message by save.ts, after
   * buildDelegationMessage produces the formatted action sentence and before
   * the closing confirmation line.
   */
  personalNote: string | null;
  /**
   * Owner-perspective status declared by the extraction model call itself for
   * this item's recipient-facing text (description for delegations,
   * suggestedMessage for messages, personalNote): "rendered" means it is
   * written as the recipient reads it (owner by name, recipient as "you",
   * quotes kept with their speaker); "unclear" means the model could not tell
   * who an "I"/"me" refers to. Set on EVERY extraction item (missing/invalid →
   * "unclear"); absent only on items built without the extraction model.
   * The declaration is never proof: the shared owner-perspective boundary
   * still verifies the text, and anything but "rendered" fails closed.
   */
  ownerPerspective?: DeclaredOwnerPerspective;
  /**
   * In-memory only, set by extractItems (never by the model): the owner's
   * original input. The shared boundary uses it to check that model-composed
   * recipient text kept the owner's language.
   */
  sourceText?: string;
  needsPerson: boolean;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  /** In-memory only. First/primary file — sets tasks.image_path. Never persisted directly. */
  imageFile?: File | null;
  /**
   * In-memory only. All photos attached to this item (up to 5). When length > 1
   * they are uploaded to task_attachments and the WhatsApp send switches to the
   * text template with an attachment note. imageFiles[0] mirrors imageFile.
   */
  imageFiles?: File[] | null;
}

export interface ExtractionResult {
  extracted: ExtractedItem[];
  summary: string;
}
