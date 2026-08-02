/**
 * carson-commitment-history.ts
 *
 * Historical Lookup — Phase 1, Q4 "Commitment History".
 *
 * Implements the frozen Historical Lookup Architecture (Carson's Memory
 * Retrieval Engine, Q4): given a keyword or person name, resolve the one
 * commitment (task/reminder/delegation) the owner means, then reconstruct
 * its full evidence-based lifecycle across every table that holds a piece
 * of that commitment's history — not just delivery status.
 *
 * Anchors on one task_id and merges, in chronological order:
 *   - tasks               (the commitment itself + its terminal status)
 *   - confirmations       (explicit completion confirmations)
 *   - whatsapp_deliveries (send/delivery/read/failure lifecycle)
 *   - quality_substitute_decisions (proof/substitution review cycle)
 *   - reminder_delivery_events     (reminder dispatch stage events)
 *   - staff_escalation_owner_decisions (owner decisions raised by this task)
 *
 * Conflict resolution: tasks.status / tasks.confirmed_at is the terminal,
 * authoritative record of "is it done" (structured lifecycle field). A
 * downstream event that contradicts it (e.g. the task is done but the
 * message never delivered, or done while an escalation is still open) is
 * never silently dropped or allowed to override the terminal state — it is
 * surfaced as an explicit caveat.
 *
 * Evidence-based answer: every claim traces to a real row and timestamp.
 * Zero matches never becomes a guess — Carson says so plainly.
 */

import { supabase } from "./supabase";
import type { Task } from "../types/task";

const TASK_COLUMNS =
  "id, user_id, description, type, assigned_to, status, due_at, confirmed_at, created_at, escalated_at, followup_sent_at, dismissed_at, archived_at, quality_review_status, quality_reviewed_at, worker_reply";

export interface CommitmentTimelineEvent {
  at: string;
  label: string;
  source:
    | "tasks"
    | "confirmations"
    | "whatsapp_deliveries"
    | "quality_substitute_decisions"
    | "reminder_delivery_events"
    | "staff_escalation_owner_decisions";
}

export interface CommitmentHistoryResult {
  task: Task;
  timeline: CommitmentTimelineEvent[];
  caveats: string[];
}

// ── Candidate resolution ──────────────────────────────────────────────────

/**
 * Finds candidate commitments matching a keyword against the task
 * description or assignee name. Deliberately searches every status and
 * archived state — Commitment History must find something regardless of
 * whether it is still active, done, cancelled, or archived.
 */
export async function findCommitmentCandidates(
  keyword: string,
  userId: string,
): Promise<Task[]> {
  const kw = keyword.trim();
  if (!kw) return [];

  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("user_id", userId)
    .or(`description.ilike.%${kw}%,assigned_to.ilike.%${kw}%`)
    .order("created_at", { ascending: false })
    .limit(6);

  if (error || !data) return [];
  return data as unknown as Task[];
}

// ── Timeline construction ─────────────────────────────────────────────────

async function fetchRelated<T>(
  table: string,
  taskId: string,
  columns: string,
  orderColumn: string,
): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq("task_id", taskId)
    .order(orderColumn, { ascending: true });
  if (error || !data) return [];
  return data as unknown as T[];
}

/**
 * Builds the full evidence-based lifecycle for one commitment: merges rows
 * from every related table into one chronological timeline, and flags any
 * conflict between the task's terminal state and a downstream event.
 */
export async function buildCommitmentHistory(
  task: Task,
): Promise<CommitmentHistoryResult> {
  const [confirmations, deliveries, qualityDecisions, reminderEvents, escalations] =
    await Promise.all([
      fetchRelated<{ confirmed_at: string; confirmed_by: string | null; source: string | null }>(
        "confirmations",
        task.id,
        "confirmed_at, confirmed_by, source",
        "confirmed_at",
      ),
      fetchRelated<{
        delivery_status: string | null;
        failure_reason: string | null;
        accepted_at: string | null;
        sent_at: string | null;
        delivered_at: string | null;
        read_at: string | null;
        failed_at: string | null;
        last_status_at: string | null;
      }>(
        "whatsapp_deliveries",
        task.id,
        "delivery_status, failure_reason, accepted_at, sent_at, delivered_at, read_at, failed_at, last_status_at",
        "last_status_at",
      ),
      fetchRelated<{
        decision: string | null;
        outcome: string | null;
        reviewed_at: string | null;
        completed_at: string | null;
      }>(
        "quality_substitute_decisions",
        task.id,
        "decision, outcome, reviewed_at, completed_at",
        "reviewed_at",
      ),
      task.type === "reminder"
        ? fetchRelated<{ stage: string; event_at: string }>(
            "reminder_delivery_events",
            task.id,
            "stage, event_at",
            "event_at",
          )
        : Promise.resolve([]),
      fetchRelated<{ status: string | null; answered_at: string | null; created_at: string }>(
        "staff_escalation_owner_decisions",
        task.id,
        "status, answered_at, created_at",
        "created_at",
      ),
    ]);

  const timeline: CommitmentTimelineEvent[] = [];

  timeline.push({ at: task.created_at, label: "Created", source: "tasks" });
  if (task.followup_sent_at) {
    timeline.push({ at: task.followup_sent_at, label: "Follow-up sent", source: "tasks" });
  }
  if (task.escalated_at) {
    timeline.push({ at: task.escalated_at, label: "Escalated to owner", source: "tasks" });
  }

  for (const d of deliveries) {
    if (d.accepted_at) timeline.push({ at: d.accepted_at, label: "Accepted by WhatsApp", source: "whatsapp_deliveries" });
    if (d.sent_at) timeline.push({ at: d.sent_at, label: "Sent", source: "whatsapp_deliveries" });
    if (d.delivered_at) timeline.push({ at: d.delivered_at, label: "Delivered", source: "whatsapp_deliveries" });
    if (d.read_at) timeline.push({ at: d.read_at, label: "Read", source: "whatsapp_deliveries" });
    if (d.failed_at) {
      timeline.push({
        at: d.failed_at,
        label: `Delivery failed${d.failure_reason ? ` (${d.failure_reason})` : ""}`,
        source: "whatsapp_deliveries",
      });
    }
  }

  for (const e of reminderEvents) {
    timeline.push({ at: e.event_at, label: `Reminder ${e.stage}`, source: "reminder_delivery_events" });
  }

  for (const esc of escalations) {
    timeline.push({ at: esc.created_at, label: "Owner decision requested", source: "staff_escalation_owner_decisions" });
    if (esc.answered_at) {
      timeline.push({ at: esc.answered_at, label: "Owner decided", source: "staff_escalation_owner_decisions" });
    }
  }

  for (const q of qualityDecisions) {
    if (q.reviewed_at) {
      timeline.push({
        at: q.reviewed_at,
        label: `Quality review: ${q.decision ?? "reviewed"}`,
        source: "quality_substitute_decisions",
      });
    }
  }

  // confirmations is the structured, first-party record of completion — always
  // included even when it duplicates tasks.confirmed_at, since it is per the
  // architecture's conflict ladder equally authoritative and may carry a
  // `source`/`confirmed_by` the task row itself does not.
  for (const c of confirmations) {
    timeline.push({
      at: c.confirmed_at,
      label: `Confirmed${c.confirmed_by ? ` by ${c.confirmed_by}` : ""}`,
      source: "confirmations",
    });
  }

  if (task.confirmed_at && confirmations.length === 0) {
    timeline.push({ at: task.confirmed_at, label: "Confirmed", source: "tasks" });
  }

  timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // ── Conflict resolution ──────────────────────────────────────────────────
  // tasks.status is the terminal, authoritative field for "is it done." A
  // downstream event that contradicts it is surfaced, never silently
  // resolved or allowed to override the terminal state.
  const caveats: string[] = [];

  if (task.status === "done") {
    const lastDelivery = deliveries[deliveries.length - 1];
    if (lastDelivery?.delivery_status === "failed") {
      caveats.push(
        "the task is marked done, though the most recent WhatsApp delivery attempt on it shows a failure — the original message may not have arrived",
      );
    }
    const openEscalation = escalations.find((e) => !e.answered_at);
    if (openEscalation) {
      caveats.push(
        "the task is marked done, though it has an owner decision on record that doesn't show as answered",
      );
    }
  }

  return { task, timeline, caveats };
}

// ── Evidence-based answer formatting ──────────────────────────────────────

function describeOutcome(task: Task): string {
  if (task.status === "cancelled") return "It was cancelled";
  if (task.status === "done") {
    const when = task.confirmed_at ? new Date(task.confirmed_at) : null;
    return when
      ? `It was confirmed done on ${when.toLocaleDateString([], { month: "short", day: "numeric" })}`
      : "It was marked done";
  }
  if (task.dismissed_at) return "It was dismissed";
  return "It's still pending";
}

/**
 * Formats the final evidence-based answer for Carson to speak or type.
 * Pure and network-free — takes an already-built history result.
 */
export function formatCommitmentHistoryAnswer(result: CommitmentHistoryResult): string {
  const { task, timeline, caveats } = result;
  const who = task.assigned_to ? ` (assigned to ${task.assigned_to})` : "";
  const lines = [`"${task.description}"${who}. ${describeOutcome(task)}.`];

  // One or two pivotal events, not the full raw log — evidence without noise.
  const pivotal = timeline.filter((e) => e.label !== "Created").slice(0, 2);
  if (pivotal.length > 0) {
    const parts = pivotal.map((e) => {
      const d = new Date(e.at).toLocaleDateString([], { month: "short", day: "numeric" });
      return `${e.label} on ${d}`;
    });
    lines.push(parts.join(", then "));
  }

  for (const caveat of caveats) {
    lines.push(`Worth noting: ${caveat}.`);
  }

  return lines.join(" ");
}

function formatCandidateSnippet(task: Task): string {
  const text = task.description.slice(0, 45).trim();
  return `"${text}${task.description.length > 45 ? "…" : ""}"`;
}

// ── Top-level orchestrator (the client-tool entry point) ──────────────────

/**
 * Q4 Commitment History entry point. Resolves the commitment by keyword,
 * disambiguates when necessary (same UX convention as act_on_note: 0 matches
 * asks the user to clarify, >1 lists up to 4 snippets and asks which one,
 * exactly 1 proceeds), then returns an evidence-based answer.
 *
 * Never guesses between multiple plausible matches — this mirrors the
 * frozen architecture's rule that Carson must never guess when more than
 * one unresolved item is plausible.
 */
export async function lookupCommitmentHistory(keyword: string): Promise<string> {
  const kw = keyword?.trim();
  if (!kw) {
    return "I need a task description or a person's name to look up. Ask the user which commitment they mean.";
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "I couldn't look that up right now — not signed in.";

  const candidates = await findCommitmentCandidates(kw, user.id);

  if (candidates.length === 0) {
    return `I don't have a record of anything matching "${kw}".`;
  }

  if (candidates.length > 1) {
    const snippets = candidates.slice(0, 4).map(formatCandidateSnippet).join(", ");
    return `I found ${candidates.length} matching "${kw}": ${snippets}. Ask the user which one they mean.`;
  }

  const history = await buildCommitmentHistory(candidates[0]);
  return formatCommitmentHistoryAnswer(history);
}
