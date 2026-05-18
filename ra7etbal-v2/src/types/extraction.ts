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
  suggestedMessage: string | null;
  needsPerson: boolean;
  needsClarification: boolean;
  clarificationQuestion: string | null;
}

export interface ExtractionResult {
  extracted: ExtractedItem[];
  summary: string;
}
