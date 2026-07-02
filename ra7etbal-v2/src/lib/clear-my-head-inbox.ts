/**
 * clear-my-head-inbox.ts
 *
 * Clear My Head Inbox: where reviewed-but-undecided thoughts land when the
 * user presses "Leave here for now" in Clear My Head Review, instead of
 * being lost when the extraction store clears.
 *
 * Distinct from:
 *   - carson_notes / carson_todos / tasks / messages — Carson's own created
 *     objects. An inbox thought only becomes one of those if the user later
 *     asks Carson to convert it.
 *   - inbox_items (src/lib/inbox.ts) — a separate, unrelated Carson-capture
 *     queue shown on Home, with its own conversion actions.
 *
 * Read-only in the UI: no editing, no conversion actions here — only save
 * (from Review) and delete.
 */

import { supabase } from "./supabase";

export interface ClearMyHeadInboxItem {
  id: string;
  text: string;
  created_at: string;
}

const COLUMNS = "id, text, created_at";

/**
 * Save one reviewed thought into the inbox for the currently signed-in user.
 * Throws on failure so the caller (Review's "Leave here for now") can
 * surface an honest error instead of silently discarding the thought.
 */
export async function saveClearMyHeadInboxItem(text: string): Promise<ClearMyHeadInboxItem> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Cannot save an empty thought to the inbox.");

  const { data, error } = await supabase
    .from("clear_my_head_inbox")
    .insert({ text: trimmed })
    .select(COLUMNS)
    .single();

  if (error) {
    console.error("[clear-my-head-inbox] saveClearMyHeadInboxItem failed:", error.message);
    throw error;
  }
  return data as ClearMyHeadInboxItem;
}

/**
 * Save multiple reviewed thoughts in one round-trip — used when "Leave here
 * for now" moves every remaining Clear My Head item into the inbox at once.
 * Throws on failure (all-or-nothing) so a partial save is never silent.
 */
export async function saveClearMyHeadInboxItems(texts: string[]): Promise<ClearMyHeadInboxItem[]> {
  const trimmed = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (trimmed.length === 0) return [];

  const { data, error } = await supabase
    .from("clear_my_head_inbox")
    .insert(trimmed.map((text) => ({ text })))
    .select(COLUMNS);

  if (error) {
    console.error("[clear-my-head-inbox] saveClearMyHeadInboxItems failed:", error.message);
    throw error;
  }
  return (data ?? []) as ClearMyHeadInboxItem[];
}

/**
 * Load inbox thoughts for the signed-in user, newest first.
 * Returns empty array on error — never throws (read path mirrors
 * carson-notes.ts / carson-todos.ts).
 */
export async function listClearMyHeadInboxItems(limit = 100): Promise<ClearMyHeadInboxItem[]> {
  const { data, error } = await supabase
    .from("clear_my_head_inbox")
    .select(COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[clear-my-head-inbox] listClearMyHeadInboxItems failed:", error.message);
    return [];
  }
  return (data ?? []) as ClearMyHeadInboxItem[];
}

/**
 * Permanently delete one inbox thought. RLS guarantees users can only
 * delete their own rows.
 */
export async function deleteClearMyHeadInboxItem(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const { error } = await supabase
    .from("clear_my_head_inbox")
    .delete()
    .eq("id", trimmed);

  if (error) {
    console.error("[clear-my-head-inbox] deleteClearMyHeadInboxItem failed:", error.message);
    throw error;
  }
}
