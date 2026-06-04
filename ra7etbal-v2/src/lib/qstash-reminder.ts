/**
 * Browser-side helpers to schedule, cancel, and reschedule QStash reminder jobs.
 *
 * All functions are fire-and-log: errors are caught and logged with console.error
 * so that a QStash failure never blocks a task mutation from completing, but is
 * always visible in the browser console.
 */

import { supabase } from "./supabase";

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function callQStashApi(
  action: "schedule" | "cancel" | "reschedule",
  taskId: string,
  dueAt?: string,
): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    console.error("[qstash-reminder] No session token — cannot call QStash API for", action, taskId);
    return;
  }

  const body: Record<string, string> = { action, taskId };
  if (dueAt) body.dueAt = dueAt;

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
export async function scheduleReminderPush(taskId: string, dueAt: string): Promise<void> {
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
  await callQStashApi("schedule", taskId, dueAt);
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
