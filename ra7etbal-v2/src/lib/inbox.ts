/**
 * Capture Inbox V1
 *
 * Stores raw thoughts for later triage. Items are not converted to tasks
 * here — that is a future step. Morning Brief will surface unprocessed items.
 */

import { supabase } from "./supabase";
import type { InboxItem, InboxItemDraft } from "../types/inbox";

const COLUMNS = "id, user_id, content, source, created_at, processed_at";

/** Save a captured thought. Throws on error. */
export async function saveInboxItem(draft: InboxItemDraft): Promise<InboxItem> {
  const { data, error } = await supabase
    .from("inbox_items")
    .insert(draft)
    .select(COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data as InboxItem;
}

/**
 * List all unprocessed inbox items for the current user.
 * Ordered newest-first.
 */
export async function listInboxItems(): Promise<InboxItem[]> {
  const { data, error } = await supabase
    .from("inbox_items")
    .select(COLUMNS)
    .is("processed_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as InboxItem[];
}

/**
 * Mark an item as processed (e.g. turned into a task, dismissed).
 */
export async function markInboxItemProcessed(id: string): Promise<void> {
  const { error } = await supabase
    .from("inbox_items")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}
