import { supabase } from "./supabase";
import type { Message, MessageDraft } from "../types/message";

const COLUMNS = "id, user_id, task_id, recipient, content, confirmation_url, created_at";

export async function listMessages(): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select(COLUMNS)
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
  const { error } = await supabase.from("messages").delete().eq("id", id);
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
