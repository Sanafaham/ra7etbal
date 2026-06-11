/**
 * Browser-side helper to schedule QStash follow-up and escalation jobs for
 * delegation tasks. Calls /api/qstash-reminder with action='schedule-escalation'.
 *
 * Fire-and-log: errors are caught and logged so a QStash failure never blocks
 * a task save from completing.
 *
 * Usage (immediately after a delegation task is created):
 *   scheduleEscalationMessages(task.id, task.created_at).catch(...)
 */

import { supabase } from "./supabase";

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Schedule follow-up (+10 min) and escalation (+20 min) QStash messages for
 * a delegation task. sentAt should be the task's created_at / sent timestamp.
 *
 * Non-blocking: returns void; all errors are logged but not thrown.
 */
export async function scheduleEscalationMessages(taskId: string, sentAt: string): Promise<void> {
  const sentMs = new Date(sentAt).getTime();
  if (Number.isNaN(sentMs)) {
    console.error("[qstash-escalation] Invalid sentAt — cannot schedule:", sentAt);
    return;
  }

  const token = await getAccessToken();
  if (!token) {
    console.error("[qstash-escalation] No session token — cannot schedule escalation for", taskId);
    return;
  }

  console.log(`[qstash-escalation] → POST /api/qstash-reminder action=schedule-escalation taskId=${taskId} sentAt=${sentAt}`);

  let res: Response;
  try {
    res = await fetch("/api/qstash-reminder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: "schedule-escalation", taskId, sentAt }),
    });
  } catch (err) {
    console.error("[qstash-escalation] fetch failed (network error):", taskId, err);
    return;
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    console.error(
      `[qstash-escalation] API ERROR — taskId=${taskId} status=${res.status}`,
      data,
    );
    return;
  }

  console.log(`[qstash-escalation] ✓ scheduled taskId=${taskId} response=`, data);
}
