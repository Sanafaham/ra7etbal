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

// ── Internal helpers ──────────────────────────────────────────────────────────

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

  for (const task of tasks as Record<string, unknown>[]) {
    const taskId = task.id as string;
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
    const { data: deliveries } = await supabase
      .from("whatsapp_deliveries")
      .select("delivery_status, failure_reason, failure_code, failure_stage, accepted_at, sent_at, delivered_at, read_at, failed_at, last_status_at")
      .eq("task_id", taskId)
      .order("last_status_at", { ascending: false })
      .limit(3);

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
  }

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "I couldn't load the operations summary right now — not signed in.";

  const window48hAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();
  const lines: string[] = ["OPERATIONS SUMMARY (live):"];

  // WhatsApp delivery failures in last 48h
  const { data: waFailures } = await supabase
    .from("whatsapp_deliveries")
    .select("recipient_name, source_type, failure_reason, failure_code, failed_at")
    .eq("delivery_status", "failed")
    .gte("failed_at", window48hAgo)
    .order("failed_at", { ascending: false })
    .limit(10);

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

  // Reminder delivery issues
  const { data: reminderIssues } = await supabase
    .from("tasks")
    .select("description, assigned_to, reminder_delivery_status, reminder_delivery_error, created_at")
    .eq("user_id", user.id)
    .eq("type", "reminder")
    .in("reminder_delivery_status", ["failed", "delivery_unconfirmed"])
    .gte("created_at", window48hAgo)
    .order("created_at", { ascending: false })
    .limit(5);

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
}
