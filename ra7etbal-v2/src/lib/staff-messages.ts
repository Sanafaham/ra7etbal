import { supabase } from "./supabase";
import type { StaffMessage } from "../types/staff-message";

/**
 * Only owner-facing columns. Never processing_status, processing_error,
 * external_message_id, user_id, person_id, thread_id, or source — those
 * stay server-side. `task:tasks(...)` embeds via the existing FK and is
 * itself subject to the `tasks` table's own owner-scoped RLS policy.
 */
const COLUMNS =
  "id, staff_name, inbound_text, carson_response, user_facing_state, next_action_owner, owner_attention_required, escalation_reason, received_at, task:tasks(description, type, status)";

/**
 * Owner-facing staff messages, most recent first.
 *
 * Relies entirely on the `staff_messages: owner can select` RLS policy
 * (auth.uid() = user_id) — never adds its own user_id filter, matching
 * listMessages()/listPeople()'s convention. Uses the standard authenticated
 * browser client (anon key + session JWT); never service_role.
 */
export async function listStaffMessages(): Promise<StaffMessage[]> {
  const { data, error } = await supabase
    .from("staff_messages")
    .select(COLUMNS)
    .order("received_at", { ascending: false });
  if (error) throw friendly(error);
  return (data ?? []) as unknown as StaffMessage[];
}

/**
 * Needs You takes priority whenever either signal is true — this is the
 * exact union rule from the task spec, not a new state. Every other value
 * passes through unchanged; user_facing_state is DB-constrained to one of
 * the four valid states, so this never needs a fallback branch.
 */
export function getStaffMessageDisplayState(
  message: Pick<StaffMessage, "user_facing_state" | "owner_attention_required">,
): StaffMessage["user_facing_state"] {
  if (message.owner_attention_required || message.user_facing_state === "Needs You") {
    return "Needs You";
  }
  return message.user_facing_state;
}

function friendly(err: { message?: string }): Error {
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("row-level security") || msg.includes("permission denied")) {
    return new Error("You don't have permission to do that.");
  }
  if (msg.includes("network") || msg.includes("failed to fetch")) {
    return new Error("Network issue. Please check your connection.");
  }
  return new Error(err.message || "Something went wrong. Please try again.");
}
