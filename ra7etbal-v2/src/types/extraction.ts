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
 */
export type ItemType =
  | "action"
  | "reminder"
  | "message"
  | "delegation"
  | "decision"
  | "followup"
  | "errand"
  | "parked";

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
  needsPerson: boolean;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  /** In-memory only. File selected by user in Review. Never persisted to Supabase. */
  imageFile?: File | null;
}

export interface ExtractionResult {
  extracted: ExtractedItem[];
  summary: string;
}
