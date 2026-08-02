import { supabase } from "./supabase";
import type {
  StaffMessage,
  OpenStaffEscalation,
  OwnerEscalationDetail,
} from "../types/staff-message";

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

// ── Phase C: open staff escalations for the Needs You list ─────────────────

/**
 * Only what's needed to decide "is this genuinely open (or failed and
 * still needing owner attention) and undecided" plus display fields.
 * `decision:staff_escalation_owner_decisions(...)` embeds via the existing
 * staff_message_id FK and is itself subject to that table's own
 * owner-scoped RLS policy — same convention as `task:tasks(...)` above.
 * Never selects owner_reply_text — this list never shows or needs the
 * answer's content, only status.
 */
const OPEN_ESCALATION_COLUMNS =
  "id, staff_name, inbound_text, escalation_reason, received_at, task_id, escalation_resolved_at, owner_attention_required, user_facing_state, decision:staff_escalation_owner_decisions(id, status, deep_link_token)";

interface RawDecisionEmbed {
  id: string;
  status: string;
  deep_link_token: string;
}

interface RawOpenEscalationRow {
  id: string;
  staff_name: string;
  inbound_text: string;
  escalation_reason: string | null;
  received_at: string;
  task_id: string | null;
  escalation_resolved_at: string | null;
  owner_attention_required: boolean;
  user_facing_state: string;
  // PostgREST returns an embedded to-one relation as either a single object
  // or a one-item array depending on schema-cache detection of the UNIQUE
  // FK — handled defensively below, same convention as
  // api/_staff-comms-engine.js's completedResult handling.
  decision: RawDecisionEmbed | RawDecisionEmbed[] | null;
}

/**
 * Open staff escalations eligible for the owner's Needs You list, most
 * recent first. A row qualifies only when ALL of:
 *   - owner_attention_required is true OR user_facing_state is 'Needs You'
 *   - escalation_resolved_at is null (set only by
 *     complete_escalation_answer_delivery on the delivered_to_staff
 *     terminal transition — the exact "removed from Needs You" condition)
 *   - the paired staff_escalation_owner_decisions row exists and its
 *     status is 'open' OR 'failed'
 *
 * Phase D: 'failed' stays visible deliberately, not just 'open'. The
 * owner tapping Approve/Reject/Custom must never make the escalation
 * disappear before delivery is actually confirmed — if the WhatsApp send
 * to staff failed, the owner's job is not done yet and this must keep
 * asking for attention (with a retry action on the owner-decision page),
 * exactly the same way it did before any answer was submitted.
 * 'answered'/'delivering' (a live attempt in flight, normally seconds
 * long) are excluded — the escalation should not visibly flicker in and
 * out of Needs You for a fast, in-progress send; a 'failed' send is the
 * one non-terminal state expected to persist long enough that hiding it
 * would be actively misleading.
 *
 * Same RLS-only convention as listStaffMessages(): no manual user_id
 * filter, standard anon-key client. A staff message with no paired
 * decision row (Phase B never reached the escalation-claim step) is
 * correctly excluded, not shown as a broken card.
 */
export async function listOpenStaffEscalationsForNeedsYou(): Promise<OpenStaffEscalation[]> {
  const { data, error } = await supabase
    .from("staff_messages")
    .select(OPEN_ESCALATION_COLUMNS)
    .is("escalation_resolved_at", null)
    .order("received_at", { ascending: false });
  if (error) throw friendly(error);
  const rows = (data ?? []) as unknown as RawOpenEscalationRow[];

  const result: OpenStaffEscalation[] = [];
  for (const row of rows) {
    const needsOwner = row.owner_attention_required || row.user_facing_state === "Needs You";
    if (!needsOwner) continue;

    const decision = Array.isArray(row.decision) ? row.decision[0] : row.decision;
    if (!decision) continue;
    if (decision.status !== "open" && decision.status !== "failed") continue;

    result.push({
      id: row.id,
      staffName: row.staff_name,
      inboundText: row.inbound_text,
      escalationReason: row.escalation_reason,
      receivedAt: row.received_at,
      taskId: row.task_id,
      decisionId: decision.id,
      deepLinkToken: decision.deep_link_token,
    });
  }
  return result;
}

// ── Phase C: secure owner-decision page lookup by deep_link_token ──────────

const ESCALATION_DETAIL_COLUMNS =
  "id, status, created_at, staff_message:staff_messages(staff_name, inbound_text, escalation_reason, received_at)";

interface RawStaffMessageEmbed {
  staff_name: string;
  inbound_text: string;
  escalation_reason: string | null;
  received_at: string;
}

interface RawEscalationDetailRow {
  id: string;
  status: OwnerEscalationDetail["status"];
  created_at: string;
  staff_message: RawStaffMessageEmbed | RawStaffMessageEmbed[] | null;
}

/**
 * Resolves a staff_escalation_owner_decisions.deep_link_token to its
 * read-only display detail, or null when the token doesn't resolve to a
 * row the signed-in owner can see.
 *
 * Security: relies entirely on the `staff_escalation_owner_decisions:
 * owner can select` RLS policy (auth.uid() = user_id) and the paired
 * `staff_messages: owner can select` policy on the embedded relation —
 * never adds a manual ownership filter, and never distinguishes "token
 * belongs to another household" from "token doesn't exist" in its return
 * value, so a caller can never learn anything about another household's
 * data from the response shape. Callers must gate this call on the owner
 * actually being signed in first; an anonymous caller would be rejected
 * by the table's GRANT (authenticated-only) before RLS is even evaluated.
 */
export async function getOwnerEscalationByToken(token: string): Promise<OwnerEscalationDetail | null> {
  const { data, error } = await supabase
    .from("staff_escalation_owner_decisions")
    .select(ESCALATION_DETAIL_COLUMNS)
    .eq("deep_link_token", token);
  if (error) throw friendly(error);

  const rows = (data ?? []) as unknown as RawEscalationDetailRow[];
  const row = rows[0];
  if (!row) return null;

  const staffMessage = Array.isArray(row.staff_message) ? row.staff_message[0] : row.staff_message;
  if (!staffMessage) return null;

  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    // 'open' is the only state still awaiting the owner's decision; every
    // other value means a reply already exists (or delivery to staff is
    // in flight/done/failed) — never fetches the reply text itself.
    alreadyAnswered: row.status !== "open",
    staffName: staffMessage.staff_name,
    inboundText: staffMessage.inbound_text,
    escalationReason: staffMessage.escalation_reason,
    receivedAt: staffMessage.received_at,
  };
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
