/**
 * carson-operations-center.ts
 *
 * P1 #3 — Operations Center V1 (COS Ch. 10, 15, 17, 20)
 *
 * Constitutional gap: `ra7etbal_state` is injected once at ElevenLabs session
 * start and never refreshed. If a WhatsApp delivery fails or a reminder is
 * not delivered after the session begins, Carson cannot see it and cannot
 * answer "did Ahmed get the message?" truthfully.
 *
 * Minimum constitutional slice (read-only, no new schema):
 *   get_task_delivery_status  — per-task delivery timeline on demand
 *   get_operations_summary    — fresh operational snapshot on demand
 *
 * Both functions query existing tables (tasks, whatsapp_deliveries) and return
 * plain text strings Carson can read aloud. They never assume success; they
 * report only what the database contains (COS Ch. 15 observation principle).
 */

import { supabase } from "./supabase";
import { listTasks } from "./tasks";
import { fetchAutomationDigest } from "./automation-context";
import { listOpenStaffEscalationsForNeedsYou } from "./staff-messages";
import { fetchUnresolvedCaptureCandidates, type UnresolvedCapture } from "./carson-unresolved-captures";
import { markCarsonNotesSurfaced } from "./carson-notes";
import { markCarsonTodosSurfaced } from "./carson-todos";
import type { Task } from "../types/task";
// PURE RELOCATION (2026-08-28, Second Brain typed hard-grounding slice):
// evidence composition + rendering moved to shared/ so the server-side
// attention read path calls the exact same functions after doing its own
// (necessarily different) I/O. Re-exported so every existing caller's
// import path (`./carson-operations-center`) and behavior are unchanged.
import { composeAttentionEvidence, renderAttentionSummary } from "../../shared/carson-attention-summary.js";
import type { AttentionItem, AttentionSummaryEvidence } from "../../shared/carson-attention-summary";
export { renderAttentionSummary };
export type { AttentionItem, AttentionSummaryEvidence };

// ── Internal helpers ──────────────────────────────────────────────────────────

// 2026-08-25 production investigation: fetchAttentionEvidence()'s per-source
// calls had no timeout anywhere in the chain (confirmed: none of listTasks,
// listOpenStaffEscalationsForNeedsYou, fetchUnresolvedCaptureCandidates, or
// their own dependencies wrap in a timeout) — a stalled connection could
// leave this hanging indefinitely rather than resolving or rejecting,
// leaving both the ElevenLabs tool call and carson-attention-intent-guard.ts's
// grounded-result check waiting with no bound. Bounded per-source, not
// per-request, so one slow source degrades to that source's own existing
// partial-failure handling instead of blocking the other two.
const ATTENTION_SOURCE_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms = ATTENTION_SOURCE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("attention evidence source timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function msToAgo(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.round(ms / 60_000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ${Math.round((h % 24))}h ago`;
}

// ── fetchTaskDeliveryStatus ───────────────────────────────────────────────────

/**
 * Searches tasks by description keyword, then fetches the WhatsApp delivery
 * timeline for each matching task.
 *
 * Returns a plain-text string Carson can read aloud. Reports only what the
 * database contains — never assumes the message was delivered (COS Ch. 15).
 */
export async function fetchTaskDeliveryStatus(keyword: string): Promise<string> {
  if (!keyword?.trim()) {
    return "Please tell me which task or person to look up.";
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "I couldn't check delivery status right now — not signed in.";

  const kw = keyword.trim().toLowerCase();

  // Search tasks matching the keyword in description or assigned_to
  const { data: tasks, error: taskError } = await supabase
    .from("tasks")
    .select("id, description, assigned_to, status, type, reminder_delivery_status, reminder_delivery_error, created_at")
    .eq("user_id", user.id)
    .or(`description.ilike.%${kw}%,assigned_to.ilike.%${kw}%`)
    .order("created_at", { ascending: false })
    .limit(5);

  if (taskError || !tasks || tasks.length === 0) {
    return `No tasks found matching "${keyword}".`;
  }

  const lines: string[] = [];

  // Fetch every matched task's WhatsApp delivery timeline concurrently
  // instead of one-at-a-time in the loop below. Same query per task (filter,
  // order, limit all unchanged) — only the network round trips are now
  // concurrent, not sequential. Promise.all preserves index-to-task
  // correspondence regardless of which query resolves first, so output
  // order below is unaffected.
  const deliveriesByTask = await Promise.all(
    (tasks as Record<string, unknown>[]).map((task) =>
      supabase
        .from("whatsapp_deliveries")
        .select("delivery_status, failure_reason, failure_code, failure_stage, accepted_at, sent_at, delivered_at, read_at, failed_at, last_status_at")
        .eq("task_id", task.id as string)
        .order("last_status_at", { ascending: false })
        .limit(3),
    ),
  );

  (tasks as Record<string, unknown>[]).forEach((task, index) => {
    const desc = (task.description as string | null) ?? "(no description)";
    const assignedTo = (task.assigned_to as string | null) ?? "unassigned";
    const taskType = (task.type as string | null) ?? "task";
    const taskStatus = (task.status as string | null) ?? "unknown";

    lines.push(`Task: "${desc.slice(0, 80)}" — assigned to ${assignedTo} (${taskType}, ${taskStatus})`);

    // Reminder delivery status
    const reminderStatus = task.reminder_delivery_status as string | null;
    if (reminderStatus && reminderStatus !== "scheduled") {
      const reminderError = task.reminder_delivery_error as string | null;
      lines.push(`  Reminder delivery: ${reminderStatus}${reminderError ? ` — ${reminderError}` : ""}`);
    }

    // WhatsApp delivery timeline from whatsapp_deliveries
    const { data: deliveries } = deliveriesByTask[index];

    if (!deliveries || deliveries.length === 0) {
      if (taskType === "delegation") {
        lines.push("  WhatsApp: no delivery record found.");
      }
    } else {
      for (const d of deliveries as Record<string, unknown>[]) {
        const status = d.delivery_status as string | null;
        const nowMs = Date.now();

        if (status === "read") {
          const readAt = d.read_at as string | null;
          lines.push(`  WhatsApp: read${readAt ? ` (${msToAgo(nowMs - new Date(readAt).getTime())})` : ""}`);
        } else if (status === "delivered") {
          const delivAt = d.delivered_at as string | null;
          lines.push(`  WhatsApp: delivered${delivAt ? ` (${msToAgo(nowMs - new Date(delivAt).getTime())})` : ""}, not yet read`);
        } else if (status === "sent") {
          const sentAt = d.sent_at as string | null;
          lines.push(`  WhatsApp: sent${sentAt ? ` (${msToAgo(nowMs - new Date(sentAt).getTime())})` : ""}, awaiting delivery`);
        } else if (status === "accepted") {
          const accAt = d.accepted_at as string | null;
          lines.push(`  WhatsApp: accepted by Meta${accAt ? ` (${msToAgo(nowMs - new Date(accAt).getTime())})` : ""}, not yet sent`);
        } else if (status === "failed") {
          const failedAt = d.failed_at as string | null;
          const reason = (d.failure_reason as string | null) ?? (d.failure_code as string | null) ?? "unknown reason";
          const stage = d.failure_stage as string | null;
          lines.push(`  WhatsApp: FAILED${failedAt ? ` (${msToAgo(nowMs - new Date(failedAt).getTime())})` : ""} — ${reason}${stage ? ` [stage: ${stage}]` : ""}`);
        } else {
          lines.push(`  WhatsApp: ${status ?? "unknown status"}`);
        }
      }
    }
  });

  return lines.join("\n");
}

// ── fetchOperationsSummary ────────────────────────────────────────────────────

/**
 * Returns a fresh operational snapshot — equivalent to the WhatsApp failures
 * block in ra7etbal_state but current at the moment of the call.
 *
 * Includes:
 *   - WhatsApp delivery failures (last 48h)
 *   - Reminders with failed or unconfirmed delivery (last 48h)
 *   - Recent delegations with no delivery record
 *
 * Carson can call this when asked "what's going on" or "is everything working."
 */
export async function fetchOperationsSummary(): Promise<string> {
  try {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      return "I couldn't load the operations summary right now — authentication check failed.";
    }
    if (!user) return "I couldn't load the operations summary right now — not signed in.";

    const window48hAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();

    // These reads are independent once the authenticated owner is known.
    // Run them concurrently so a fresh voice session does not pay two
    // sequential Supabase round trips before returning the summary.
    const [waResult, reminderResult] = await Promise.all([
      supabase
        .from("whatsapp_deliveries")
        .select("recipient_name, source_type, failure_reason, failure_code, failed_at")
        .eq("delivery_status", "failed")
        .gte("failed_at", window48hAgo)
        .order("failed_at", { ascending: false })
        .limit(10),
      supabase
        .from("tasks")
        .select("description, assigned_to, reminder_delivery_status, reminder_delivery_error, created_at")
        .eq("user_id", user.id)
        .eq("type", "reminder")
        .in("reminder_delivery_status", ["failed", "delivery_unconfirmed"])
        .gte("created_at", window48hAgo)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    if (waResult.error || reminderResult.error) {
      return "I couldn't load the operations summary right now — one or more live status checks failed.";
    }

    const waFailures = waResult.data;
    const reminderIssues = reminderResult.data;
    const lines: string[] = ["OPERATIONS SUMMARY (live):"];
    const nowMs = Date.now();

    if (waFailures && waFailures.length > 0) {
      lines.push(`WhatsApp delivery failures (${waFailures.length}):`);
      for (const f of waFailures as Record<string, unknown>[]) {
        const who = (f.recipient_name as string | null) ? ` to ${f.recipient_name as string}` : "";
        const failedAt = f.failed_at as string | null;
        const age = failedAt ? msToAgo(nowMs - new Date(failedAt).getTime()) : "unknown time";
        const reason = (f.failure_reason as string | null) ?? (f.failure_code as string | null) ?? "unknown reason";
        lines.push(`  - Failed${who} (${age}): ${reason}`);
      }
    } else {
      lines.push("No WhatsApp delivery failures in the last 48 hours.");
    }

    if (reminderIssues && reminderIssues.length > 0) {
      lines.push(`Reminder delivery issues (${reminderIssues.length}):`);
      for (const r of reminderIssues as Record<string, unknown>[]) {
        const desc = ((r.description as string | null) ?? "(no description)").slice(0, 60);
        const status = r.reminder_delivery_status as string;
        const error = r.reminder_delivery_error as string | null;
        lines.push(`  - "${desc}" — ${status}${error ? `: ${error}` : ""}`);
      }
    } else {
      lines.push("No reminder delivery issues in the last 48 hours.");
    }

    return lines.join("\n");
  } catch {
    return "I couldn't load the operations summary right now — the live status check did not complete.";
  }
}

// ── fetchAttentionSummary ─────────────────────────────────────────────────────

/**
 * get_items_needing_attention — the Second Brain grounded-attention proof.
 *
 * Structured-first: fetchAttentionEvidence() produces a narrow evidence
 * object containing only fields the actually-retrieved data supports;
 * renderAttentionSummary() is a pure, deterministic string builder with no
 * LLM step. This split is the enforcement point — the render function can
 * never state an item that isn't present in the evidence it was given.
 *
 * "needsAttention" and "waiting" deliberately reuse morning-brief.ts's
 * buildMorningBrief() classification (the same relevance-tuned classifier
 * that already powers the live spoken Morning Brief/Night Sweep) rather
 * than daily-brief.ts's older, separately-tested isNeedsYouTask() —
 * morning-brief.ts is the classifier actually answering this exact
 * question today. "waiting" also folds in open staff escalations via
 * listOpenStaffEscalationsForNeedsYou(), the same read-only source
 * proactive_opening_brief already uses for its own Needs You slot.
 *
 * carsonCanHandle and safeToIgnore are intentionally always empty in this
 * slice: no existing signal in the data model currently distinguishes
 * "Carson could act on this" or "this is safe to ignore" from the other
 * buckets, and inventing one here would fabricate a classification the
 * retrieved data does not support. Documented, not silently omitted.
 */
// AttentionItem, AttentionSummaryEvidence, renderAttentionSummary: see
// shared/carson-attention-summary.js — imported and re-exported above,
// pure relocation, no behavior change.

export async function fetchAttentionEvidence(): Promise<AttentionSummaryEvidence> {
  const generatedAt = new Date().toISOString();
  const empty = {
    needsYou: [] as AttentionItem[],
    overdueReminders: [] as AttentionItem[],
    upcomingReminders: [] as AttentionItem[],
    waiting: [] as AttentionItem[],
    later: [] as AttentionItem[],
    unresolvedCaptures: [] as AttentionItem[],
  };

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, code: "attention_auth_failed", generatedAt, completeness: "none", ...empty };
  }

  const now = new Date();

  // Kick off all three independent, fallible sources concurrently — each
  // wrapped in its own bounded timeout — rather than awaiting them one at a
  // time. Each promise is created (starting its underlying request) before
  // any of them is awaited, so they genuinely run in parallel; each is then
  // awaited with its own try/catch, preserving the exact same per-source
  // failure semantics as before (a slow/failed source degrades only its own
  // *Failed flag, never blocks or fails the other two).
  const tasksPromise = withTimeout(listTasks());
  const needsYouPromise = withTimeout(listOpenStaffEscalationsForNeedsYou());
  const capturesPromise = withTimeout(fetchUnresolvedCaptureCandidates(now));
  // fetchAutomationDigest never throws — it returns an empty digest on
  // auth failure or query error, so routineAutomationTaskIds below is
  // always defined (possibly empty), never undefined-because-it-threw.
  const digestPromise = fetchAutomationDigest();

  let tasks: Task[] | null = null;
  let tasksFailed = false;
  try {
    tasks = await tasksPromise;
  } catch {
    tasksFailed = true;
  }

  let needsYou: Awaited<ReturnType<typeof listOpenStaffEscalationsForNeedsYou>> | null = null;
  let needsYouFailed = false;
  try {
    needsYou = await needsYouPromise;
  } catch {
    needsYouFailed = true;
  }

  let captureCandidates: UnresolvedCapture[] | null = null;
  let capturesFailed = false;
  try {
    captureCandidates = await capturesPromise;
  } catch {
    capturesFailed = true;
  }

  const digest = await digestPromise;

  const evidence = composeAttentionEvidence({
    generatedAt,
    now,
    tasks,
    tasksFailed,
    needsYou,
    needsYouFailed,
    captureCandidates,
    routineAutomationTaskIds: digest.routineAutomationTaskIds,
    capturesFailed,
  });

  // last_surfaced_at must mean "actually included in this rendered
  // response" — never "merely retrieved." Only the classifier's selected
  // subset qualifies; anything filtered out is never marked, so it remains
  // eligible to be genuinely surfaced later instead of silently
  // disappearing. Best-effort, non-blocking: a failed write here must not
  // fail the read the user is waiting on.
  if (evidence.selectedCaptureIds && evidence.selectedCaptureIds.length > 0) {
    const noteIds = evidence.selectedCaptureIds.filter((c) => c.kind === "note").map((c) => c.id);
    const todoIds = evidence.selectedCaptureIds.filter((c) => c.kind === "todo").map((c) => c.id);
    if (noteIds.length > 0) markCarsonNotesSurfaced(noteIds).catch(() => {});
    if (todoIds.length > 0) markCarsonTodosSurfaced(todoIds).catch(() => {});
  }

  return evidence;
}

export async function fetchAttentionSummary(): Promise<string> {
  try {
    const evidence = await fetchAttentionEvidence();
    return renderAttentionSummary(evidence);
  } catch {
    return "I couldn't check what needs your attention right now — the live check didn't complete.";
  }
}
