/**
 * Browser-side helpers to schedule, cancel, and reschedule QStash reminder jobs.
 *
 * Schedule/cancel/reschedule mutations are fire-and-log. Creation is different:
 * createRoutedReminder is the required server-authoritative persistence boundary
 * and throws unless the server proves the reminder row was saved.
 */

import { supabase } from "./supabase";
import type { OneTimeRoutingEvidence } from "./one-time-automation-routing";
import type { Task } from "../types/task";

export const REMINDER_CREATION_CONTRACT_VERSION = "reminder-creation-v1" as const;
export type ReminderCreationSource = "voice" | "inbox" | "todos" | "save" | "act_on_note";

export interface ReminderCreationContract {
  contract_version: typeof REMINDER_CREATION_CONTRACT_VERSION;
  source: ReminderCreationSource;
  operation_id: string;
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Authoritative one-off reminder boundary. Voice calls carry routing evidence;
 * other current UI writers carry a narrow creation contract. */
export async function createRoutedReminder(input: {
  description: string;
  dueAt: string | null;
  imagePath?: string | null;
  routingEvidence?: OneTimeRoutingEvidence;
  creationContract?: ReminderCreationContract;
}): Promise<Task> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not signed in.");
  const res = await fetch("/api/qstash-reminder", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: "create-and-schedule",
      description: input.description,
      dueAt: input.dueAt,
      imagePath: input.imagePath ?? null,
      routingEvidence: input.routingEvidence,
      creationContract: input.creationContract,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.task?.id) {
    throw new Error(data?.error || "Could not create the reminder.");
  }
  return data.task as Task;
}

async function callQStashApi(
  action: "schedule" | "cancel" | "reschedule",
  taskId: string,
  dueAt?: string,
  routingEvidence?: OneTimeRoutingEvidence,
): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    console.error("[qstash-reminder] No session token — cannot call QStash API for", action, taskId);
    return;
  }

  const body: Record<string, unknown> = { action, taskId };
  if (dueAt) body.dueAt = dueAt;
  if (routingEvidence) body.routingEvidence = routingEvidence;

  console.log(`[qstash-reminder] → POST /api/qstash-reminder action=${action} taskId=${taskId} dueAt=${dueAt ?? "n/a"}`);

  let res: Response;
  try {
    res = await fetch("/api/qstash-reminder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[qstash-reminder] fetch failed (network error):", action, taskId, err);
    return;
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    console.error(
      `[qstash-reminder] API ERROR — action=${action} taskId=${taskId} status=${res.status}`,
      data,
    );
    return;
  }

  console.log(`[qstash-reminder] ✓ action=${action} taskId=${taskId} response=`, data);
}

/** Schedule a QStash push job at the reminder's exact due_at time. */
export async function scheduleReminderPush(
  taskId: string,
  dueAt: string,
  routingEvidence?: OneTimeRoutingEvidence,
): Promise<void> {
  const dueMs = new Date(dueAt).getTime();
  if (Number.isNaN(dueMs)) {
    console.error("[qstash-reminder] Invalid dueAt — cannot schedule:", dueAt);
    return;
  }
  // Skip only if more than 1 minute in the past — pg_cron safety net will handle it
  if (dueMs < Date.now() - 60_000) {
    console.warn("[qstash-reminder] dueAt >1 min in past — skipping QStash, pg_cron safety net covers it:", dueAt);
    return;
  }
  await callQStashApi("schedule", taskId, dueAt, routingEvidence);
}

/** Cancel the QStash push job for a reminder (on delete or mark done). */
export async function cancelReminderPush(taskId: string): Promise<void> {
  await callQStashApi("cancel", taskId);
}

/**
 * Reschedule the QStash push job when due_at is edited.
 * Cancels the old job and schedules a new one atomically server-side.
 */
export async function rescheduleReminderPush(taskId: string, newDueAt: string): Promise<void> {
  const dueMs = new Date(newDueAt).getTime();
  if (Number.isNaN(dueMs)) {
    console.error("[qstash-reminder] Invalid newDueAt — cannot reschedule:", newDueAt);
    return;
  }
  if (dueMs < Date.now() - 60_000) {
    // New time already in the past — cancel existing job, pg_cron picks it up
    await callQStashApi("cancel", taskId);
    return;
  }
  await callQStashApi("reschedule", taskId, newDueAt);
}
