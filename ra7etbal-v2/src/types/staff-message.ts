/**
 * StaffMessage — a read-only projection of the `staff_messages` table for
 * owner-facing display (Owner Visibility V1). Only the columns needed for
 * display are included here; internal fields (processing_status,
 * processing_error, external_message_id, user_id, person_id, thread_id,
 * source) are never selected by the browser query in
 * `src/lib/staff-messages.ts`, so they never reach the client at all.
 */

export type StaffMessageState = "Waiting" | "Needs You" | "Completed" | "In Progress";
export type StaffMessageNextActionOwner = "carson" | "staff" | "owner" | "nobody";

/** Minimal linked-task context, embedded via the tasks FK — never a raw task id. */
export interface StaffMessageTaskContext {
  description: string;
  type: string;
  status: string;
}

export interface StaffMessage {
  id: string;
  staff_name: string;
  inbound_text: string;
  carson_response: string | null;
  user_facing_state: StaffMessageState;
  next_action_owner: StaffMessageNextActionOwner;
  owner_attention_required: boolean;
  /** The exact decision needed from the owner. Only meaningful when owner_attention_required is true. */
  escalation_reason: string | null;
  received_at: string;
  /** Present only when linked to a task the owner can still see (RLS-scoped); null otherwise. */
  task: StaffMessageTaskContext | null;
}

/**
 * Phase C — an open staff escalation (Phase B: staff_messages +
 * staff_escalation_owner_decisions) eligible to appear in the owner's Needs
 * You list. Only ever built from rows where the escalation is genuinely
 * still open and unanswered — see listOpenStaffEscalationsForNeedsYou().
 */
export interface OpenStaffEscalation {
  /** staff_messages.id — used as the React key and for task-linkage dedup. */
  id: string;
  staffName: string;
  inboundText: string;
  escalationReason: string | null;
  receivedAt: string;
  /** Linked task id, when present — used only to avoid showing the same item twice. */
  taskId: string | null;
  /** staff_escalation_owner_decisions.id */
  decisionId: string;
  /** staff_escalation_owner_decisions.deep_link_token — the review-page identifier. */
  deepLinkToken: string;
}

export type OwnerEscalationDecisionStatus =
  | "open"
  | "answered"
  | "delivering"
  | "delivered_to_staff"
  | "failed";

/**
 * Phase C — the read-only detail shown on the secure owner-decision page
 * reached via deep_link_token. Never includes anything that would let the
 * page answer or resolve the escalation — this type has no write surface.
 */
export interface OwnerEscalationDetail {
  /** staff_escalation_owner_decisions.id */
  id: string;
  status: OwnerEscalationDecisionStatus;
  createdAt: string;
  /** True once the owner has already replied — the exact answer text is never fetched by this read-only page. */
  alreadyAnswered: boolean;
  staffName: string;
  inboundText: string;
  escalationReason: string | null;
  receivedAt: string;
}
