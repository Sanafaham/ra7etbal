import { supabase } from "./supabase";
import type { Message, MessageDraft } from "../types/message";

const COLUMNS =
  "id, user_id, task_id, recipient, content, confirmation_url, archived_at, created_at";

/** Active workspace messages — excludes archived rows. */
export async function listMessages(): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select(COLUMNS)
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) throw friendly(error);
  return (data ?? []) as Message[];
}

/**
 * Messages whose linked tasks are in history (done or archived), plus any
 * messages that were archived directly. Used by /history alongside the
 * history tasks so we can render the message body next to its task.
 */
export async function listHistoryMessages(taskIds: string[]): Promise<Message[]> {
  if (taskIds.length === 0) {
    // Still surface any directly-archived messages even if no history tasks.
    const { data, error } = await supabase
      .from("messages")
      .select(COLUMNS)
      .not("archived_at", "is", null)
      .order("created_at", { ascending: false });
    if (error) throw friendly(error);
    return (data ?? []) as Message[];
  }

  const { data, error } = await supabase
    .from("messages")
    .select(COLUMNS)
    .or(`task_id.in.(${taskIds.join(",")}),archived_at.not.is.null`)
    .order("created_at", { ascending: false });
  if (error) throw friendly(error);
  return (data ?? []) as Message[];
}

export async function createMessage(draft: MessageDraft): Promise<Message> {
  const { data, error } = await supabase
    .from("messages")
    .insert(draft)
    .select(COLUMNS)
    .single();
  if (error) throw friendly(error);
  return data as Message;
}

export async function deleteMessage(id: string): Promise<void> {
  const { count, error } = await supabase
    .from("messages")
    .delete({ count: "exact" })
    .eq("id", id);
  if (error) throw friendly(error);
  if (count === 0) throw new Error("Message was not deleted. Please try again.");
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
