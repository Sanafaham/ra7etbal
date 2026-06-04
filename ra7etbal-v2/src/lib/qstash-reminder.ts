/**
 * Browser-side helpers to schedule, cancel, and reschedule QStash reminder jobs.
 *
 * These call /api/qstash-reminder (Vercel serverless) so the QSTASH_TOKEN
 * never touches the browser.
 *
 * All functions are fire-and-log: errors are caught and logged rather than
 * thrown so that a QStash failure never blocks a task mutation from completing.
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
    console.warn("[qstash-reminder] No session token — skipping QStash call for", action, taskId);
    return;
  }

  const body: Record<string, string> = { action, taskId };
  if (dueAt) body.dueAt = dueAt;

  const res = await fetch("/api/qstash-reminder", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    console.warn("[qstash-reminder] API error", action, taskId, res.status, data);
  }
}

/** Schedule a QStash push job at the reminder's exact due_at time. */
export async function scheduleReminderPush(taskId: string, dueAt: string): Promise<void> {
  const dueMs = new Date(dueAt).getTime();
  if (Number.isNaN(dueMs)) {
    console.warn("[qstash-reminder] Invalid dueAt — skipping schedule", dueAt);
    return;
  }
  // Only schedule if due_at is in the future (or within a reasonable window).
  // Past reminders are handled immediately by pg_cron safety net.
  if (dueMs < Date.now() - 60_000) {
    console.warn("[qstash-reminder] dueAt is more than 1 minute in the past — skipping QStash schedule", dueAt);
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
    console.warn("[qstash-reminder] Invalid newDueAt — skipping reschedule", newDueAt);
    return;
  }
  if (dueMs < Date.now() - 60_000) {
    // New time is already in the past — cancel existing job, pg_cron picks it up
    await callQStashApi("cancel", taskId);
    return;
  }
  await callQStashApi("reschedule", taskId, newDueAt);
}
