import { supabase } from "./supabase";
import type { Task, TaskDraft, TaskPatch } from "../types/task";

const COLUMNS =
  "id, user_id, description, type, assigned_to, status, needs_follow_up, confirmation_url, confirmed_at, due_at, archived_at, created_at, qstash_message_id, followup_sent_at, escalated_at, image_path, proof_image_path, quality_review_status, quality_review_note, quality_reviewed_at";

/**
 * Active workspace tasks — excludes archived rows. Used by Actions /
 * Follow-ups / Messages screens.
 */
export async function listTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select(COLUMNS)
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) throw friendly(error);
  return (data ?? []) as Task[];
}

/**
 * Logbook tasks for /history. Includes everything that is either marked
 * done OR has been archived. A pending task that was never archived stays
 * out of history — it's still active work.
 */
export async function listHistoryTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select(COLUMNS)
    .or("status.eq.done,archived_at.not.is.null")
    .order("confirmed_at", { ascending: false, nullsFirst: false });
  if (error) throw friendly(error);
  return (data ?? []) as Task[];
}

export async function createTask(draft: TaskDraft): Promise<Task> {
  const { data, error } = await supabase
    .from("tasks")
    .insert(draft)
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return data as Task;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  const { data, error } = await supabase
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return data as Task;
}

/**
 * Hide selected completed tasks from the active workspace while keeping them
 * available in /history. Used for dismissing Night Sweep handled items.
 */
export async function archiveDoneTasks(ids: string[]): Promise<Task[]> {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  if (uniqueIds.length === 0) return [];

  const { data, error } = await supabase
    .from("tasks")
    .update({ archived_at: new Date().toISOString() })
    .in("id", uniqueIds)
    .eq("status", "done")
    .is("archived_at", null)
    .select(COLUMNS);
  if (error) throw friendly(error);
  return (data ?? []) as Task[];
}

/**
 * Write the confirmation URL onto a task after it has been created.
 * confirmation_url is intentionally excluded from TaskPatch (write-once at
 * save time), so this narrow helper bypasses the typed patch.
 */
export async function updateTaskConfirmationUrl(
  id: string,
  url: string,
): Promise<Task> {
  const { data, error } = await supabase
    .from("tasks")
    .update({ confirmation_url: url })
    .eq("id", id)
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return data as Task;
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.from("tasks").delete().eq("id", id);
  if (error) throw friendly(error);
}

/**
 * Bulk-delete completed history items (Updates → History → Clear History).
 * The `.eq("status", "done")` guard mirrors archiveDoneTasks — even if a
 * caller ever passed a stray id, only done tasks can be removed this way.
 */
export async function deleteTasks(ids: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
  if (uniqueIds.length === 0) return;

  const { error } = await supabase
    .from("tasks")
    .delete()
    .in("id", uniqueIds)
    .eq("status", "done");
  if (error) throw friendly(error);
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
