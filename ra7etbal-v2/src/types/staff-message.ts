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
