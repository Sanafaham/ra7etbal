import { supabase } from "./supabase";

/**
 * Archive completed coordination.
 *
 * Sets archived_at = now() on every task with status = "done" that isn't
 * already archived, plus every message linked to one of those tasks (via
 * task_id). The rows remain in the database — they just disappear from
 * the active workspace (Actions / Follow-ups / Messages) and surface in
 * /history.
 *
 * RLS scopes the writes to `user_id = auth.uid()`; the explicit
 * `eq('user_id', userId)` is belt-and-braces.
 */
export async function archiveCompleted(userId: string): Promise<{
  tasksArchived: number;
  messagesArchived: number;
}> {
  if (!userId) throw new Error("Not signed in.");

  // 1) Find done, not-yet-archived task ids.
  const { data: doneTasks, error: lookupErr } = await supabase
    .from("tasks")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "done")
    .is("archived_at", null);
  if (lookupErr) throw friendly(lookupErr);
  const taskIds = (doneTasks ?? []).map((t) => t.id as string);

  if (taskIds.length === 0) {
    return { tasksArchived: 0, messagesArchived: 0 };
  }

  const now = new Date().toISOString();

  // 2) Archive the tasks.
  const taskUpdate = await supabase
    .from("tasks")
    .update({ archived_at: now }, { count: "exact" })
    .eq("user_id", userId)
    .in("id", taskIds);
  if (taskUpdate.error) throw friendly(taskUpdate.error);

  // 3) Archive every message linked to one of those tasks (active or not).
  const msgUpdate = await supabase
    .from("messages")
    .update({ archived_at: now }, { count: "exact" })
    .eq("user_id", userId)
    .in("task_id", taskIds)
    .is("archived_at", null);
  if (msgUpdate.error) throw friendly(msgUpdate.error);

  return {
    tasksArchived: taskUpdate.count ?? taskIds.length,
    messagesArchived: msgUpdate.count ?? 0,
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
  return new Error(err.message || "Could not archive. Please try again.");
}
