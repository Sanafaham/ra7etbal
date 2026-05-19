import { supabase } from "./supabase";

/**
 * Delete all of the signed-in user's tasks and messages.
 *
 * RLS already scopes these tables to `user_id = auth.uid()`, so the
 * `delete().neq("id", ...)` form below cannot affect anyone else's rows.
 * We also pass an explicit `eq("user_id", userId)` as belt-and-braces in
 * case any legacy row exists without a user_id (which would already be
 * invisible to the user but the policy refuses to delete what it can't
 * see anyway — this is purely defensive).
 *
 * Order matters: messages first (some link to tasks via task_id),
 * then tasks. People, profiles, auth, drafts, and extraction settings
 * are intentionally untouched.
 */
export async function clearUserData(userId: string): Promise<{
  messagesDeleted: number;
  tasksDeleted: number;
}> {
  if (!userId) throw new Error("Not signed in.");

  // Messages first.
  const msgDel = await supabase
    .from("messages")
    .delete({ count: "exact" })
    .eq("user_id", userId);
  if (msgDel.error) throw friendly(msgDel.error);

  // Then tasks.
  const taskDel = await supabase
    .from("tasks")
    .delete({ count: "exact" })
    .eq("user_id", userId);
  if (taskDel.error) throw friendly(taskDel.error);

  return {
    messagesDeleted: msgDel.count ?? 0,
    tasksDeleted: taskDel.count ?? 0,
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
  return new Error(err.message || "Cleanup failed. Please try again.");
}
